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
// DEFERRED (not ported): the two authoring PATCH routes (questions/rules
// edits) and the stats/iaa/summary routes.

import type { RouteEntry } from "./router.js";
import { mutate as mutateReviewState, withReviewsRoot } from "./lib/domain/review/index.js";
import { sessionReviewsRoot } from "./lib/session-reviews.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
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
        });
        return { ok: true, version: result.version };
      });
    },
  },
];
