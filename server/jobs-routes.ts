// M6.3 — jobs queue, viewer tokens, guideline diff/versions, and the
// patient-import POST. Each was a one-off `app.get/post(...)` in v1's
// server.ts; grouped here because they're small, unrelated to the
// bigger feature surfaces, and all read-mostly.
//
// Endpoints:
//   GET    /api/jobs                          — list jobs
//   GET    /api/jobs/:jobId                   — manifest + status
//   GET    /api/jobs/:jobId/transcript        — append-only stream
//   POST   /api/auth/viewer-token             — issue (requires auth)
//   GET    /api/auth/viewer-tokens            — list (requires auth)
//   DELETE /api/auth/viewer-tokens/:token     — revoke (requires auth)
//   GET    /api/diff/:taskId                  — compute guideline diff
//   POST   /api/runs/:runId/patients/:patientId/import — import agent draft

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { readReviewerFromRequest } from "./auth.js";
import {
  listJobs, getJobManifest, getJobStatus, readJobTranscript,
  type JobKind,
} from "./lib/jobs.js";
import {
  issueViewerToken, listViewerTokens, revokeViewerToken,
} from "./lib/auth.js";
import { loadVersionedTask } from "./lib/version-archive.js";
import { computeTaskDiff } from "./lib/task-diff.js";
import {
  getRunManifest,
} from "./lib/infra/batch-run/index.js";
import { sessionIdForRun } from "./lib/session-reviews.js";
import { getSessionManifest } from "./lib/domain/iter/index.js";
import { deriveNerReviewStatus } from "./lib/review-completion.js";
import { pathFor } from "@chart-review/storage";
import type { RuleEvent, RuleRollup, RuleEventsProvenance } from "@chart-review/platform-types";

// Path resolution — uses the canonical PLATFORM_ROOT from
// @chart-review/patients (v2's directory), not this file's old default
// that walked up to v1. Without this, the import route looks for run
// directories at v1's path even though startBatchRun wrote them under
// v2.
import { PLATFORM_ROOT as V2_PLATFORM_ROOT } from "@chart-review/patients";

function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT ?? V2_PLATFORM_ROOT;
}
function runsRoot(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(platformRoot(), "var", "runs");
}

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function requireAuth(req: Parameters<RouteEntry["handler"]>[1]): string {
  const reviewerId = readReviewerFromRequest(req);
  if (!reviewerId) throw httpErr(401, "authentication required");
  return reviewerId;
}

/**
 * Pure builder for the base review_state produced when importing an agent
 * draft into a session. Exported so tests can exercise it without spinning
 * up the HTTP server. The handler calls this and then mutates the returned
 * object to add NER / adherence / merge-preserve fields — those remain
 * inline because they depend on complex handler-local state.
 */
export function buildImportedReviewState(
  patientId: string,
  taskId: string,
  runId: string,
  primaryDraft: { field_assessments?: unknown[]; encounters?: unknown[] },
  importedAgents: string[],
  reviewStatus: string,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    patient_id: patientId,
    task_id: taskId,
    review_status: reviewStatus,
    field_assessments: Array.isArray(primaryDraft.field_assessments) ? primaryDraft.field_assessments : [],
    imported_from_run: runId,
    imported_at: new Date().toISOString(),
    imported_agents: importedAgents,
  };
  if (Array.isArray(primaryDraft.encounters) && primaryDraft.encounters.length > 0) {
    state.encounters = primaryDraft.encounters;
  }
  return state;
}

/**
 * Pure merge for the adherence-specific fields of an imported review_state.
 * Exported (mirroring buildImportedReviewState) so tests can exercise the
 * reviewer-win merge semantics without spinning up a run manifest + on-disk
 * agent drafts. The handler calls this after the ingest() loop has built
 * the first-agent-wins canonical arrays and the per-agent shadow maps.
 *
 * Reviewer-win semantics (question_answers / rule_verdicts / rule_events):
 * a row the reviewer already edited (source==="reviewer") on the EXISTING
 * review_state survives a re-import by its stable id (question_id / rule_id
 * / event_id); everything else comes from the new draft. Agent-map shadow
 * fields: agent_question_answers / agent_rule_verdicts REPLACE wholesale on
 * every re-import (deliberate, pre-existing — this iter's per-agent drafts
 * are the only ones kept; do NOT "fix" this to merge). agent_rule_events
 * instead MERGES per-agent key — existing shadows spread first, this
 * import's non-empty per-agent drafts spread on top — so an agent absent
 * from, or reporting zero events in, THIS import doesn't erase its
 * previously-recorded shadow. rule_rollups are derived (not
 * reviewer-editable directly) — per rule_id, keep the EXISTING
 * (reviewer-recomputed) rollup for rules that have a reviewer-sourced
 * event, else take the new draft's.
 */
export function mergeAdherenceImport(
  existing: Record<string, unknown>,
  input: {
    questionAnswers: unknown[];
    ruleVerdicts: unknown[];
    ruleEvents: RuleEvent[];
    ruleRollups: RuleRollup[];
    /** Provenance stamped at seed time (spec 2026-08-24 Task 5 review,
     *  Important 2) — first-agent-wins, mirroring ruleEvents/ruleRollups.
     *  Undefined for a legacy/period-only draft (predates the stamp) or a
     *  draft whose runner predates this field. */
    ruleEventsProvenance?: RuleEventsProvenance;
    adherenceExcluded?: boolean;
    adherenceExclusionReason?: string;
    agentQuestionAnswers: Record<string, unknown[]>;
    agentRuleVerdicts: Record<string, unknown[]>;
    agentRuleEvents: Record<string, RuleEvent[]>;
  },
): Record<string, unknown> {
  const {
    questionAnswers, ruleVerdicts, ruleEvents, ruleRollups, ruleEventsProvenance,
    adherenceExcluded, adherenceExclusionReason,
    agentQuestionAnswers, agentRuleVerdicts, agentRuleEvents,
  } = input;

  const existingQa = (existing.question_answers as Array<{
    question_id: string; source?: string;
  }> | undefined) ?? [];
  const existingRv = (existing.rule_verdicts as Array<{
    rule_id: string; source?: string;
  }> | undefined) ?? [];
  const reviewerQa = existingQa.filter((q) => q.source === "reviewer");
  const reviewerRv = existingRv.filter((v) => v.source === "reviewer");
  const reviewerQidSet = new Set(reviewerQa.map((q) => q.question_id));
  const reviewerRidSet = new Set(reviewerRv.map((v) => v.rule_id));

  // Merged canonical lists: reviewer wins per question_id / rule_id;
  // the agent's new draft fills in everything else.
  const mergedQa: unknown[] = [
    ...reviewerQa,
    ...(questionAnswers as Array<{ question_id: string }>).filter(
      (q) => !reviewerQidSet.has(q.question_id),
    ),
  ];
  const mergedRv: unknown[] = [
    ...reviewerRv,
    ...(ruleVerdicts as Array<{ rule_id: string }>).filter(
      (v) => !reviewerRidSet.has(v.rule_id),
    ),
  ];

  const out: Record<string, unknown> = {
    question_answers: mergedQa,
    rule_verdicts: mergedRv,
    task_kind: "adherence",
  };

  // Agent-map fields: always refreshed with the new iter's drafts.
  if (Object.keys(agentQuestionAnswers).length > 0) out.agent_question_answers = agentQuestionAnswers;
  if (Object.keys(agentRuleVerdicts).length > 0) out.agent_rule_verdicts = agentRuleVerdicts;

  // Preserve reviewer validation markers verbatim.
  if (Array.isArray(existing.validated_questions)) out.validated_questions = existing.validated_questions;
  if (Array.isArray(existing.validated_rules)) out.validated_rules = existing.validated_rules;

  if (adherenceExcluded !== undefined) out.adherence_excluded = adherenceExcluded;
  if (adherenceExclusionReason) out.adherence_exclusion_reason = adherenceExclusionReason;

  // Event-level concordance (spec 2026-08-24): reviewer-sourced events win
  // by event_id on reimport; agent_rule_events MERGES per-agent key (see
  // below) — unlike agent_question_answers / agent_rule_verdicts above,
  // which replace wholesale; rollups are derived data — per rule_id, keep
  // the reviewer's recomputed rollup for rules that have a reviewer-sourced
  // event, else take the draft's. A draft with no rule_events carries no
  // event-level information at all (legacy or period-only pipeline output
  // — reachable here because the outer merge guard fires on
  // ruleVerdicts.length alone) — preserve whatever the state already has
  // instead of replacing it with an empty list. Only an event-bearing
  // draft may rewrite the event arrays.
  if (ruleEvents.length > 0) {
    // Fresh work-list this import → fresh provenance stamp (or, if this
    // draft predates the stamp, fall through to whatever the state already
    // had rather than dropping it to undefined).
    out.rule_events_provenance = ruleEventsProvenance ?? existing.rule_events_provenance;
    const existingEvents = (existing.rule_events as RuleEvent[] | undefined) ?? [];
    const reviewerEvents = new Map(
      existingEvents.filter((e) => e.source === "reviewer").map((e) => [e.event_id, e]),
    );
    const mergedEvents = ruleEvents.map((e) => reviewerEvents.get(e.event_id) ?? e);
    for (const [id, ev] of reviewerEvents) {
      if (!mergedEvents.some((e) => e.event_id === id)) mergedEvents.push(ev);
    }
    out.rule_events = mergedEvents;

    // Per-rule rollup merge: a rule with a reviewer-sourced event keeps the
    // EXISTING (reviewer-consistent) rollup; every other rule takes the
    // fresh draft's — so later imports keep updating rollups for rules the
    // reviewer never touched, instead of freezing the whole array the
    // moment ANY rule gets a reviewer event (Task 3 re-review B6).
    const reviewerRuleIds = new Set([...reviewerEvents.values()].map((e) => e.rule_id));
    const existingRollupsByRule = new Map(
      ((existing.rule_rollups as RuleRollup[] | undefined) ?? []).map((r) => [r.rule_id, r]),
    );
    const draftRollupsByRule = new Map(ruleRollups.map((r) => [r.rule_id, r]));
    const allRuleIds = new Set([...existingRollupsByRule.keys(), ...draftRollupsByRule.keys()]);
    out.rule_rollups = [...allRuleIds].map((rid) =>
      reviewerRuleIds.has(rid)
        ? (existingRollupsByRule.get(rid) ?? draftRollupsByRule.get(rid)!)
        : (draftRollupsByRule.get(rid) ?? existingRollupsByRule.get(rid)!),
    );

    // Merge (not replace) the per-agent shadow map — a single re-import only
    // carries the agent(s) enumerated THIS time; other agents' prior shadows
    // must survive. Defense in depth (Task 3 re-review A1): drop any
    // present-but-empty entries before spreading, so this site agrees with
    // the ingest loop's "empty carries no information" guard even if an
    // empty array ever slips through here.
    const nonEmptyAgentRuleEvents = Object.fromEntries(
      Object.entries(agentRuleEvents).filter(([, evs]) => evs.length > 0),
    );
    out.agent_rule_events = {
      ...((existing.agent_rule_events as Record<string, RuleEvent[]> | undefined) ?? {}),
      ...nonEmptyAgentRuleEvents,
    };
  } else {
    out.rule_events = existing.rule_events;
    out.rule_rollups = existing.rule_rollups;
    out.agent_rule_events = existing.agent_rule_events;
    out.rule_events_provenance = existing.rule_events_provenance;
  }
  out.validated_events = (existing.validated_events as string[] | undefined) ?? [];

  return out;
}

export const jobsRoutes: RouteEntry[] = [
  // ── /api/jobs/* ─────────────────────────────────────────────────────
  {
    method: "GET", pattern: "/api/jobs",
    handler: async (_b, _r, _p, query) => {
      const kind = query.get("kind") ?? undefined;
      const task_id = query.get("task_id") ?? undefined;
      const limitStr = query.get("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;
      return listJobs({ kind: kind as JobKind | undefined, task_id, limit });
    },
  },
  {
    method: "GET", pattern: "/api/jobs/:jobId",
    handler: async (_b, _r, p) => {
      const m = getJobManifest(p.jobId);
      const s = getJobStatus(p.jobId);
      if (!m || !s) throw httpErr(404, "job not found");
      return { manifest: m, status: s };
    },
  },
  {
    method: "GET", pattern: "/api/jobs/:jobId/transcript",
    handler: async (_b, _r, p, query) => {
      const sinceLineRaw = query.get("since");
      const sinceLine = sinceLineRaw ? parseInt(sinceLineRaw, 10) : 0;
      return readJobTranscript(p.jobId, { sinceLine: isNaN(sinceLine) ? 0 : sinceLine });
    },
  },

  // ── /api/auth/viewer-token + /viewer-tokens ─────────────────────────
  {
    method: "POST", pattern: "/api/auth/viewer-token",
    handler: async (body, req) => {
      const reviewerId = requireAuth(req);
      const { task_id, expires_in_days } = (body ?? {}) as {
        task_id?: string; expires_in_days?: number;
      };
      if (!task_id) throw httpErr(400, "task_id required");
      const v = issueViewerToken(task_id, expires_in_days ?? 30, reviewerId);
      // Best-effort URL: rewrite the API port to Vite's dev port.
      const host = req.headers.host ?? "localhost:3002";
      const viewerHost = host.replace(":3002", ":5174").replace(":3001", ":5173");
      const url = `http://${viewerHost}/methodologist/${task_id}?viewer=${v.token}`;
      return { ok: true, ...v, url };
    },
  },
  {
    method: "GET", pattern: "/api/auth/viewer-tokens",
    handler: async (_b, req) => {
      requireAuth(req);
      return listViewerTokens();
    },
  },
  {
    method: "DELETE", pattern: "/api/auth/viewer-tokens/:token",
    handler: async (_b, req, p) => {
      requireAuth(req);
      return { ok: revokeViewerToken(p.token) };
    },
  },

  // ── /api/diff/:taskId ───────────────────────────────────────────────
  {
    method: "GET", pattern: "/api/diff/:taskId",
    handler: async (_b, _r, p, query) => {
      const from = query.get("from");
      const to = query.get("to");
      if (!from || !to) {
        const err = httpErr(400, "from and to query params required");
        (err as Error & { payload?: unknown }).payload = { ok: false };
        throw err;
      }
      const fromTask = loadVersionedTask(p.taskId, from);
      const toTask = loadVersionedTask(p.taskId, to);
      if (!fromTask || !toTask) {
        const err = httpErr(404, "version not found");
        (err as Error & { payload?: unknown }).payload = { ok: false };
        throw err;
      }
      return computeTaskDiff(fromTask, toTask, from, to);
    },
  },

  // ── /api/runs/:runId/patients/:patientId/import ─────────────────────
  // Copies the agent draft (phenotype field_assessments OR NER span_labels)
  // into reviews/<patient>/<task>/review_state.json so the reviewer has
  // something to validate against. Refuses to overwrite an existing
  // review_state unless force:true. Also refuses (409) when the run's
  // owning session is BLIND (spec 2026-08-24 Task 5 review, Critical 1) —
  // the last line of defense behind the client's own blind-mode guards, so
  // a curl/API call or a stale UI can't overwrite a blind gold session's
  // review_state with agent output.
  //
  // Three on-disk shapes:
  //   1. per_patient/<pid>/agent_draft.json — legacy single-agent
  //      (phenotype). Imported verbatim.
  //   2. per_patient/<pid>/agents/agent_1.json — multi-agent path,
  //      single agent. Imported verbatim.
  //   3. per_patient/<pid>/agents/agent_1.json + agent_2.json + … —
  //      multi-agent run with N>1 agents (NER). Span lists are MERGED
  //      with per-span provenance: a span proposed by both agents is
  //      deduped by span_id and carries `proposed_by: [agent_1, agent_2]`.
  //      Phenotype field_assessments take the first agent's draft
  //      verbatim (multi-agent merging on field_assessments lives in
  //      pilot routes, not here).
  {
    method: "POST", pattern: "/api/runs/:runId/patients/:patientId/import",
    handler: async (body, _req, p) => {
      const force = (body as { force?: boolean })?.force === true;
      const manifest = getRunManifest(p.runId);
      if (!manifest) throw httpErr(404, "run not found");

      const legacyDraft = path.join(runsRoot(), p.runId, "per_patient", p.patientId, "agent_draft.json");
      const agentsDir = path.join(runsRoot(), p.runId, "per_patient", p.patientId, "agents");
      // Enumerate agent drafts. Sort so agent_1 wins ties (matches the
      // legacy "first agent's draft" semantics for phenotype).
      const agentDrafts: { id: string; path: string }[] = [];
      if (fs.existsSync(agentsDir)) {
        for (const f of fs.readdirSync(agentsDir).sort()) {
          if (f.endsWith(".json") && !f.endsWith(".error.json")) {
            agentDrafts.push({ id: f.replace(/\.json$/, ""), path: path.join(agentsDir, f) });
          }
        }
      }
      // Resolve drafts to read. Legacy single-file path is the fallback.
      const hasMultiAgent = agentDrafts.length > 0;
      const legacyExists = fs.existsSync(legacyDraft);
      if (!hasMultiAgent && !legacyExists) {
        throw httpErr(404, "draft not found for this patient in this run");
      }

      const taskId = manifest.task_id;
      const sid = sessionIdForRun(taskId, p.runId);
      if (!sid) {
        throw httpErr(409, `run ${p.runId} has no owning session; cannot import`);
      }
      // Blind gold-collection sessions (adherence spec 2026-08-24 Task 5)
      // must NEVER receive an agent draft, regardless of how the request
      // was made — this is the last line of defense behind the client's
      // own blind-mode guards, so a curl/API call or a stale UI can't
      // silently overwrite the gold arm with agent output.
      const owningSession = getSessionManifest(taskId, sid);
      if (owningSession?.blind) {
        throw httpErr(409, `session ${sid} is a blind gold-collection session; agent import is refused`);
      }
      const reviewStatePath = pathFor.reviewState(sid, p.patientId, taskId);
      if (fs.existsSync(reviewStatePath) && !force) {
        const err = httpErr(409, "review_state already exists for this patient×task; pass force:true to overwrite");
        (err as Error & { payload?: unknown }).payload = { ok: false };
        throw err;
      }

      type AnyDraft = {
        field_assessments?: unknown[];
        span_labels?: Array<{ span_id?: string; [k: string]: unknown }>;
        question_answers?: unknown[];
        rule_verdicts?: unknown[];
        rule_events?: RuleEvent[];
        rule_rollups?: RuleRollup[];
        rule_events_provenance?: RuleEventsProvenance;
        excluded?: boolean;
        exclusion_reason?: string;
        task_kind?: string;
        encounters?: unknown[];
      };

      // Phenotype field_assessments: use the first agent's draft (or
      // legacy single-file). NER span_labels: merge all agent drafts by
      // span_id with per-span proposed_by[] provenance. Adherence
      // question_answers + rule_verdicts: take the first agent's
      // verbatim (single-agent pattern; multi-agent reconciliation TBD).
      let fieldAssessments: unknown[] = [];
      let encounters: unknown[] | undefined;
      let questionAnswers: unknown[] = [];
      let ruleVerdicts: unknown[] = [];
      let ruleEvents: RuleEvent[] = [];
      let ruleRollups: RuleRollup[] = [];
      let ruleEventsProvenance: RuleEventsProvenance | undefined;
      let adherenceExcluded: boolean | undefined;
      let adherenceExclusionReason: string | undefined;
      // Per-agent shadow drafts for adherence so the UI can render A/B
      // provenance per question. The canonical question_answers stays
      // first-agent-wins (the reviewer's starting point); these are
      // read-only and indexed by agent id.
      const agentQuestionAnswers: Record<string, unknown[]> = {};
      const agentRuleVerdicts: Record<string, unknown[]> = {};
      const agentRuleEvents: Record<string, RuleEvent[]> = {};
      const mergedSpans = new Map<string, Record<string, unknown> & { proposed_by: string[] }>();
      const sources: string[] = [];

      const ingest = (id: string, draft: AnyDraft) => {
        if (Array.isArray(draft.field_assessments) && fieldAssessments.length === 0) {
          fieldAssessments = draft.field_assessments;
        }
        if (Array.isArray(draft.encounters) && !encounters) {
          encounters = draft.encounters;
        }
        if (Array.isArray(draft.question_answers)) {
          if (questionAnswers.length === 0) questionAnswers = draft.question_answers;
          agentQuestionAnswers[id] = draft.question_answers;
        }
        if (Array.isArray(draft.rule_verdicts)) {
          if (ruleVerdicts.length === 0) ruleVerdicts = draft.rule_verdicts;
          agentRuleVerdicts[id] = draft.rule_verdicts;
        }
        if (Array.isArray(draft.rule_events)) {
          if (ruleEvents.length === 0) {
            ruleEvents = draft.rule_events;
            ruleEventsProvenance = draft.rule_events_provenance;
          }
          // Present-but-empty carries no event-level information (a
          // period-only rule set, or an agent that committed zero events
          // this run) — recording it as this agent's shadow would erase
          // that agent's previously-imported shadow at the merge spread in
          // mergeAdherenceImport below (Task 3 re-review A1). Only record
          // a shadow when non-empty.
          if (draft.rule_events.length > 0) agentRuleEvents[id] = draft.rule_events;
        }
        if (Array.isArray(draft.rule_rollups) && ruleRollups.length === 0) {
          ruleRollups = draft.rule_rollups;
        }
        if (typeof draft.excluded === "boolean" && adherenceExcluded === undefined) {
          adherenceExcluded = draft.excluded;
          adherenceExclusionReason = draft.exclusion_reason;
        }
        if (Array.isArray(draft.span_labels)) {
          for (const s of draft.span_labels) {
            const sid = String(s.span_id ?? "");
            if (!sid) continue;
            const existing = mergedSpans.get(sid);
            if (existing) {
              if (!existing.proposed_by.includes(id)) existing.proposed_by.push(id);
            } else {
              mergedSpans.set(sid, { ...s, proposed_by: [id] });
            }
          }
        }
      };

      if (hasMultiAgent) {
        for (const a of agentDrafts) {
          try {
            ingest(a.id, JSON.parse(fs.readFileSync(a.path, "utf8")) as AnyDraft);
            sources.push(a.path);
          } catch { /* skip malformed */ }
        }
      } else {
        try {
          ingest("agent", JSON.parse(fs.readFileSync(legacyDraft, "utf8")) as AnyDraft);
          sources.push(legacyDraft);
        } catch { /* skip malformed */ }
      }

      fs.mkdirSync(path.dirname(reviewStatePath), { recursive: true });

      // Merge-preserve: when an EXISTING review_state has reviewer work
      // on it, importing a fresh agent draft must NOT clobber that work.
      // Only matters when force:true is used to re-import for a later
      // iter (iter_002+); the file existed-or-not check earlier already
      // refused the non-forced case. Specifically preserve:
      //   - source=reviewer rows in question_answers / rule_verdicts
      //   - the validated_questions / validated_rules arrays
      //   - review_status if it's already past "agent_drafted"
      // Agent-map fields (agent_question_answers / agent_rule_verdicts)
      // are REPLACED with the new iter's drafts so the AdherenceReview UI
      // shows current A1/A2 answers in the read-only columns.
      let existing: Record<string, unknown> = {};
      if (force && fs.existsSync(reviewStatePath)) {
        try { existing = JSON.parse(fs.readFileSync(reviewStatePath, "utf8")); }
        catch { /* malformed → fall through to fresh write */ }
      }

      const reviewStatus = (existing.review_status && existing.review_status !== "agent_drafted"
        ? existing.review_status as string
        : "agent_drafted");
      const importedAgents = hasMultiAgent ? agentDrafts.map((a) => a.id) : ["agent"];
      const reviewState = buildImportedReviewState(
        p.patientId,
        taskId,
        p.runId,
        { field_assessments: fieldAssessments, encounters },
        importedAgents,
        reviewStatus,
      );

      if (mergedSpans.size > 0) {
        reviewState.span_labels = [...mergedSpans.values()];
        reviewState.task_kind = "ner";
        // Preserve the NER reviewer's note-validation markers verbatim across a
        // re-import (symmetric with validated_questions/rules below) — otherwise
        // a re-run silently drops the reviewer's curation.
        if (Array.isArray(existing.validated_notes)) {
          reviewState.validated_notes = existing.validated_notes;
        }
        // Re-derive review_status from the preserved note-validations vs the
        // (re)merged spans, so we never persist a contradiction like
        // reviewer_validated with zero validated_notes, and a re-run that adds
        // new notes correctly drops back to in_progress. (The generic
        // review_status set above is for phenotype; "locked" is never reopened.)
        if (existing.review_status !== "locked") {
          reviewState.review_status = deriveNerReviewStatus({
            span_labels: reviewState.span_labels as Array<{ note_id: string }>,
            validated_notes: reviewState.validated_notes as string[] | undefined,
          }) ?? "agent_drafted";
        }
      }

      if (
        questionAnswers.length > 0 || ruleVerdicts.length > 0 ||
        adherenceExcluded !== undefined || ruleEvents.length > 0
      ) {
        Object.assign(
          reviewState,
          mergeAdherenceImport(existing, {
            questionAnswers, ruleVerdicts, ruleEvents, ruleRollups, ruleEventsProvenance,
            adherenceExcluded, adherenceExclusionReason,
            agentQuestionAnswers, agentRuleVerdicts, agentRuleEvents,
          }),
        );
      }
      fs.writeFileSync(reviewStatePath, JSON.stringify(reviewState, null, 2));
      return {
        ok: true,
        imported_to: reviewStatePath,
        sources,
        agents: hasMultiAgent ? agentDrafts.map((a) => a.id) : ["agent"],
        span_count: mergedSpans.size,
        question_count: questionAnswers.length,
        verdict_count: ruleVerdicts.length,
      };
    },
  },
];
