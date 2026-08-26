// Adherence-task server routes (concur MVP).
//
// Companion to review-routes.ts (phenotype). Surfaces the question
// framework + rule definitions of an adherence task to the AdherenceReview
// pane, plus reviewer accept / override actions for question answers and
// rule verdicts.
//
// All write routes are session-scoped (sessionReviewsRoot(sid) +
// withReviewsRoot, guarded by the sessionIdOf 400-check) so sessions stay
// isolated — matching the phenotype review routes.
//
// Routes:
//   GET   /api/tasks/:taskId/adherence
//     → { questions_by_tier, rules, attribution_categories }   (for the UI)
//
//   POST  /api/reviews/:patientId/:taskId/adherence/question-answer
//     body: { question_id, answer, confidence?, evidence?, reasoning? }
//     Reviewer accepts / overrides one question answer; resolves tier from
//     the skill, sets source:"reviewer", and marks validated_questions.
//
//   POST  /api/reviews/:patientId/:taskId/adherence/rule-verdict
//     body: { rule_id, verdict, attribution?, rationale? }
//     Reviewer overrides one rule verdict; marks validated_rules.
//
//   POST  /api/reviews/:patientId/:taskId/adherence/event-verdict
//     body: { event_id, answers?: [{question_id, answer}], evaluable?, evaluable_reason? }
//     Reviewer overrides one event's answers (or its evaluability); the
//     deterministic engine then re-derives THAT rule's per-event verdicts,
//     rollup, and mirrored rule_verdict. Marks validated_events. Verdicts
//     are NOT settable here — they are engine-derived; rule-verdict above
//     remains the reviewer's explicit period-level override channel.
//
//   POST  /api/reviews/:patientId/:taskId/adherence/seed-events
//     body: {}
//     Blind-annotation mode (gold-standard collection, spec 2026-08-24
//     Task 5): seeds state.rule_events with the SAME deterministic
//     work-list the agent got (rules × the patient's ETL anchor lists via
//     expandEventWorklist) — no agent output involved at all. 409s when
//     rule_events is already non-empty (never overwrites in-progress or
//     completed work). Deliberately does NOT compute rule_rollups /
//     rule_verdicts — there is nothing to derive yet (no answers exist);
//     those are computed later, per event, by the SAME event-verdict route
//     above as the annotator answers each event, and the gold's own
//     verdicts for IAA/compare purposes are derived downstream by Task 6/7
//     tooling, not by this route.
//
//     Workflow this enables: create an isolated session (e.g.
//     "blind-v06"), open #/patient/<taskId>/<patientId>?blind=1 with that
//     session active, annotate every event (saves go through the existing
//     event-verdict route above — no new write path needed) — the gold
//     lives in that session's review_state. Task 6 adds a compare mode
//     that reads a second session's events; Task 7 computes per-event IAA
//     between them.
//
// DEFERRED (not ported): the two authoring PATCH routes (questions/rules
// edits) and the stats/iaa/summary routes.

import type { RouteEntry } from "./router.js";
import { mutate as mutateReviewState, withReviewsRoot } from "./lib/domain/review/index.js";
import { sessionReviewsRoot } from "./lib/session-reviews.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { readAnchors } from "@chart-review/patients";
import {
  loadAdherenceSkill, expandEventWorklist, toAnchorEntries,
} from "@chart-review/pipeline-extract-adherence";
import { evaluateAllRuleEvents } from "@chart-review/rule-engine";
import { deriveAdherenceReviewStatus } from "./lib/review-completion.js";
import type {
  QuestionAnswer, RuleVerdict, AttributionCategory,
} from "@chart-review/platform-types";

function httpErr(status: number, payload: unknown): Error & { status: number; payload?: unknown } {
  const message =
    typeof payload === "object" && payload && "message" in payload
      ? String((payload as { message?: unknown }).message ?? "error")
      : "error";
  const err = new Error(message) as Error & { status: number; payload?: unknown };
  err.status = status;
  err.payload = payload;
  return err;
}

/** Workspace session id from the query — required for committed-state writes
 *  so sessions stay isolated. Mirrors review-routes.ts. */
function sessionIdOf(query: URLSearchParams): string {
  const sid = query.get("session_id");
  if (!sid) throw httpErr(400, { ok: false, message: "session_id query param is required" });
  return sid;
}

function adherenceTaskOrFail(taskId: string): NonNullable<ReturnType<typeof loadCompiledTask>> {
  const task = loadCompiledTask(taskId);
  if (!task) throw httpErr(404, { ok: false, message: `task ${taskId} not found` });
  if (task.task_kind !== "adherence") {
    throw httpErr(400, {
      ok: false,
      message: `task ${taskId} is not an adherence task (task_kind=${task.task_kind ?? "phenotype"})`,
    });
  }
  return task;
}

export const adherenceRoutes: RouteEntry[] = [
  // ── Framework (read) ──────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/api/tasks/:taskId/adherence",
    handler: async (_body, _req, p) => {
      adherenceTaskOrFail(p.taskId);
      const skill = loadAdherenceSkill(p.taskId);
      const questions_by_tier: Record<number, unknown[]> = {};
      for (const [tier, qs] of skill.questions_by_tier) {
        questions_by_tier[tier] = qs;
      }
      return {
        ok: true,
        task_id: p.taskId,
        questions_by_tier,
        rules: skill.rules,
        attribution_categories: skill.attribution_categories,
      };
    },
  },

  // ── Reviewer actions ──────────────────────────────────────────────────────
  {
    method: "POST",
    pattern: "/api/reviews/:patientId/:taskId/adherence/question-answer",
    handler: async (body, _req, p, query) => {
      const sid = sessionIdOf(query);
      return withReviewsRoot(sessionReviewsRoot(sid), async () => {
        const task = adherenceTaskOrFail(p.taskId);
        const b = (body ?? {}) as Partial<QuestionAnswer> & { question_id?: string };
        if (!b.question_id) throw httpErr(400, { ok: false, message: "question_id required" });
        // Resolve tier from the skill so the caller doesn't have to re-send it.
        const skill = loadAdherenceSkill(p.taskId);
        let tier: number | undefined;
        for (const [t, qs] of skill.questions_by_tier) {
          if (qs.some((q) => q.question_id === b.question_id)) { tier = t; break; }
        }
        if (tier === undefined) {
          throw httpErr(404, {
            ok: false, message: `question ${b.question_id} not found in task ${p.taskId}`,
          });
        }
        const questionIds: string[] = [];
        for (const [, qs] of skill.questions_by_tier) for (const q of qs) questionIds.push(q.question_id);
        const ruleIds = skill.rules.map((r) => r.rule_id);
        const result = mutateReviewState(p.patientId, task, "reviewer", (state) => {
          state.task_kind = "adherence";
          const qa = state.question_answers ?? [];
          const idx = qa.findIndex((a) => a.question_id === b.question_id);
          const patched: QuestionAnswer = {
            question_id: b.question_id!,
            tier: tier!,
            answer: (b.answer ?? null) as QuestionAnswer["answer"],
            confidence: b.confidence,
            evidence: b.evidence,
            reasoning: b.reasoning,
            verifier_status: b.verifier_status,
            source: "reviewer",
            ts: new Date().toISOString(),
          };
          if (idx >= 0) qa[idx] = patched;
          else qa.push(patched);
          state.question_answers = qa;
          const validated = new Set(state.validated_questions ?? []);
          validated.add(b.question_id!);
          state.validated_questions = [...validated];
          // Maintain review_status so the patient shows validated OUTSIDE this
          // pane once every question + rule is validated (see review-completion).
          if (state.review_status !== "locked") {
            const derived = deriveAdherenceReviewStatus(state, { questionIds, ruleIds });
            if (derived) state.review_status = derived;
          }
        });
        return { ok: true, version: result.version };
      });
    },
  },

  {
    method: "POST",
    pattern: "/api/reviews/:patientId/:taskId/adherence/rule-verdict",
    handler: async (body, _req, p, query) => {
      const sid = sessionIdOf(query);
      return withReviewsRoot(sessionReviewsRoot(sid), async () => {
        const task = adherenceTaskOrFail(p.taskId);
        const b = (body ?? {}) as {
          rule_id?: string;
          verdict?: RuleVerdict["verdict"];
          attribution?: AttributionCategory;
          rationale?: string;
        };
        if (!b.rule_id) throw httpErr(400, { ok: false, message: "rule_id required" });
        if (b.verdict !== "CONCORDANT" && b.verdict !== "NON_CONCORDANT" && b.verdict !== "EXCLUDED") {
          throw httpErr(400, { ok: false, message: "verdict must be CONCORDANT | NON_CONCORDANT | EXCLUDED" });
        }
        const skill = loadAdherenceSkill(p.taskId);
        const questionIds: string[] = [];
        for (const [, qs] of skill.questions_by_tier) for (const q of qs) questionIds.push(q.question_id);
        const ruleIds = skill.rules.map((r) => r.rule_id);
        const result = mutateReviewState(p.patientId, task, "reviewer", (state) => {
          state.task_kind = "adherence";
          const verdicts = state.rule_verdicts ?? [];
          const idx = verdicts.findIndex((v) => v.rule_id === b.rule_id);
          const patched: RuleVerdict = {
            rule_id: b.rule_id!,
            verdict: b.verdict!,
            attribution: b.attribution,
            rationale: b.rationale,
            source: "reviewer",
            ts: new Date().toISOString(),
          };
          if (idx >= 0) verdicts[idx] = patched;
          else verdicts.push(patched);
          state.rule_verdicts = verdicts;
          const validated = new Set(state.validated_rules ?? []);
          validated.add(b.rule_id!);
          state.validated_rules = [...validated];
          if (state.review_status !== "locked") {
            const derived = deriveAdherenceReviewStatus(state, { questionIds, ruleIds });
            if (derived) state.review_status = derived;
          }
        });
        return { ok: true, version: result.version };
      });
    },
  },

  // POST /api/reviews/:patientId/:taskId/adherence/event-verdict
  //   body: { event_id, answers?: [{question_id, answer}], evaluable?, evaluable_reason? }
  // Reviewer overrides one event's answers (or its evaluability); the
  // deterministic engine then re-derives THAT rule's per-event verdicts,
  // rollup, and mirrored rule_verdict, so the dual-track stays consistent.
  // Marks validated_events. Verdicts are NOT settable here — they are
  // engine-derived; the period-level rule-verdict route remains the
  // reviewer's explicit override channel.
  {
    method: "POST",
    pattern: "/api/reviews/:patientId/:taskId/adherence/event-verdict",
    handler: async (body, _req, p, query) => {
      const sid = sessionIdOf(query);
      return withReviewsRoot(sessionReviewsRoot(sid), async () => {
        const task = adherenceTaskOrFail(p.taskId);
        const b = (body ?? {}) as {
          event_id?: string;
          answers?: Array<{ question_id: string; answer: QuestionAnswer["answer"] }>;
          evaluable?: boolean;
          evaluable_reason?: string;
        };
        if (!b.event_id) throw httpErr(400, { ok: false, message: "event_id required" });
        if (b.evaluable === false && !b.evaluable_reason) {
          throw httpErr(400, { ok: false, message: "evaluable:false requires evaluable_reason" });
        }
        const skill = loadAdherenceSkill(p.taskId);
        const qTier = new Map<string, number>();
        for (const [t, qs] of skill.questions_by_tier) for (const q of qs) qTier.set(q.question_id, t);
        for (const a of b.answers ?? []) {
          if (!qTier.has(a.question_id)) {
            throw httpErr(404, { ok: false, message: `question ${a.question_id} not found in task ${p.taskId}` });
          }
        }
        const questionIds = [...qTier.keys()];
        const ruleIds = skill.rules.map((r) => r.rule_id);
        const result = mutateReviewState(p.patientId, task, "reviewer", (state) => {
          state.task_kind = "adherence";
          const events = [...(state.rule_events ?? [])];
          const idx = events.findIndex((e) => e.event_id === b.event_id);
          if (idx < 0) throw httpErr(404, { ok: false, message: `event ${b.event_id} not found` });
          const ev = { ...events[idx] };
          for (const a of b.answers ?? []) {
            const answers = (ev.answers ?? []).filter((x) => x.question_id !== a.question_id);
            answers.push({
              question_id: a.question_id,
              tier: qTier.get(a.question_id)!,
              answer: a.answer,
              source: "reviewer",
              ts: new Date().toISOString(),
            });
            ev.answers = answers;
          }
          if (b.evaluable !== undefined) {
            ev.evaluable = b.evaluable;
            ev.evaluable_reason = b.evaluable === false ? b.evaluable_reason : undefined;
          }
          ev.source = "reviewer";
          ev.ts = new Date().toISOString();
          events[idx] = ev;
          // Re-derive this rule's per-event verdicts + rollup + mirrored verdict.
          const rule = skill.rules.find((r) => r.rule_id === ev.rule_id);
          if (rule) {
            const ruleEvents = events.filter((e) => e.rule_id === rule.rule_id);
            const res = evaluateAllRuleEvents([rule], state.question_answers ?? [], ruleEvents);
            const byId = new Map(res.rule_events.map((e) => [e.event_id, e]));
            state.rule_events = events.map((e) =>
              e.rule_id === rule.rule_id
                ? { ...(byId.get(e.event_id) ?? e), source: e.source, ts: e.ts }
                : e,
            );
            state.rule_rollups = [
              ...(state.rule_rollups ?? []).filter((r) => r.rule_id !== rule.rule_id),
              ...res.rule_rollups,
            ];
            state.rule_verdicts = [
              ...(state.rule_verdicts ?? []).filter((v) => v.rule_id !== rule.rule_id),
              ...res.rule_verdicts,
            ];
          } else {
            state.rule_events = events;
          }
          const validated = new Set(state.validated_events ?? []);
          validated.add(b.event_id!);
          state.validated_events = [...validated];
          if (state.review_status !== "locked") {
            const derived = deriveAdherenceReviewStatus(state, { questionIds, ruleIds });
            if (derived) state.review_status = derived;
          }
        });
        return { ok: true, version: result.version };
      });
    },
  },

  // POST /api/reviews/:patientId/:taskId/adherence/seed-events
  //   body: {}
  // Blind-annotation mode (spec 2026-08-24 Task 5): seeds rule_events with
  // the deterministic ETL work-list (rules × the patient's anchor lists) —
  // NO agent output. 409s if rule_events is already non-empty, so a
  // reviewer's in-progress or completed work is never clobbered. See the
  // route-list comment above for the full workflow this enables.
  {
    method: "POST",
    pattern: "/api/reviews/:patientId/:taskId/adherence/seed-events",
    handler: async (_body, _req, p, query) => {
      const sid = sessionIdOf(query);
      return withReviewsRoot(sessionReviewsRoot(sid), async () => {
        const task = adherenceTaskOrFail(p.taskId);
        const skill = loadAdherenceSkill(p.taskId);
        let eventCount = 0;
        const result = mutateReviewState(p.patientId, task, "reviewer", (state) => {
          if ((state.rule_events ?? []).length > 0) {
            throw httpErr(409, {
              ok: false,
              message: `rule_events already seeded for patient ${p.patientId} × task ${p.taskId}; refusing to overwrite`,
            });
          }
          const anchorsRaw = readAnchors(p.patientId);
          const anchors = Object.fromEntries(
            Object.entries(anchorsRaw).map(([k, v]) => [k, toAnchorEntries(v)]),
          );
          const worklist = expandEventWorklist(skill.rules, anchors);
          eventCount = worklist.length;
          state.task_kind = "adherence";
          state.rule_events = worklist;
          // Deliberately NOT computing rule_rollups/rule_verdicts here — no
          // answers exist yet to derive them from. Those populate
          // per-event as the annotator saves each event through the
          // existing event-verdict route above; the gold's own verdicts
          // for cross-session IAA/compare are derived downstream by
          // Task 6/7 tooling, not by this route.
        });
        return { ok: true, version: result.version, events: eventCount };
      });
    },
  },
];
