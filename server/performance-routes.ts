// Performance report routes (light platform).
//
// GET /api/performance/:taskId — PER-AGENT agent-vs-human accuracy across the
// patients the reviewer has validated for this task. This is the DECIDE-phase
// "performance after human validation" report.
//
// For each validated patient we take the reviewer's final answer on each
// human-decided field, then look up EACH agent's draft for that patient from
// the run the review was imported from (review_state.imported_from_run →
// var/runs/<run>/per_patient/<pid>/agents/<agent>.json) and compare. This
// gives a true default-vs-skeptical leaderboard rather than scoring a single
// agent's snapshot.

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { loadCompiledTask } from "@chart-review/tasks";
import { listPilotIterations } from "./lib/domain/iter/index.js";

interface FieldAssessment {
  field_id: string;
  answer?: unknown;
  source?: string;
  status?: string;
}
interface ReviewState {
  field_assessments?: FieldAssessment[];
  imported_from_run?: string;
  review_status?: string;
}

function answersEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** A field is scored only when a human has decided it (reviewer-sourced). */
function isHumanDecided(fa: FieldAssessment): boolean {
  return fa.source === "reviewer" || fa.status === "approved" || fa.status === "overridden";
}

interface Cell { n_evaluable: number; n_correct: number; }
type AgentCounts = Record<string, Record<string, Cell>>; // agentId -> fieldId -> cell

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return null; }
}

export function computePerformance(
  sessionId: string,
  taskId: string,
  primaryCriterionIds: string[],
  runOverride?: string | null,
) {
  const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
  const sessionDir = path.join(reviewsRoot, sessionId);
  const runsDir = process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(PLATFORM_ROOT, "var", "runs");
  // Carry-forward scoring: each field is scored against the MOST-RECENT run
  // that actually drafted it — mirroring how review_state carries answers
  // forward across focused re-runs. A focused re-run (one criterion) updates
  // that field's score without erasing fields drafted in an earlier
  // whole-guideline run, and an imported run is still scored when a later
  // focused iter exists. (Previously we scored everything against the single
  // latest iter's run, so a cancer_type-only re-run zeroed every other field.)
  const sessionIters = listPilotIterations(taskId)
    .filter((i) => i.session_id === sessionId && i.state !== "abandoned" && i.run_id)
    .sort((a, b) => b.iter_num - a.iter_num); // most-recent first
  // Run chain, most-recent first. An explicit run (from an iter tab) scores the
  // cumulative state as of that iter; otherwise the whole session chain.
  let runChain: string[];
  if (runOverride) {
    const sel = sessionIters.find((i) => i.run_id === runOverride);
    runChain = sel
      ? sessionIters.filter((i) => i.iter_num <= sel.iter_num).map((i) => i.run_id as string)
      : [runOverride];
  } else {
    runChain = sessionIters.map((i) => i.run_id as string);
  }
  const agentCounts: AgentCounts = {};
  const agentIds = new Set<string>();
  const validatedPatients = new Set<string>();

  const ensure = (agentId: string, fid: string): Cell => {
    (agentCounts[agentId] ??= {});
    return (agentCounts[agentId][fid] ??= { n_evaluable: 0, n_correct: 0 });
  };

  if (fs.existsSync(sessionDir)) {
    for (const pid of fs.readdirSync(sessionDir)) {
      if (pid.startsWith(".")) continue;
      const state = readJson<ReviewState>(path.join(sessionDir, pid, taskId, "review_state.json"));
      if (!state) continue;
      if (state.review_status !== "reviewer_validated") continue;

      // Human's final answer for each human-decided primary field.
      const humanFinal: Record<string, unknown> = {};
      for (const fa of state.field_assessments ?? []) {
        if (!primaryCriterionIds.includes(fa.field_id)) continue;
        if (!isHumanDecided(fa)) continue;
        humanFinal[fa.field_id] = fa.answer;
      }
      const decidedFields = Object.keys(humanFinal);
      if (decidedFields.length === 0) continue;

      // Walk the run chain (most-recent first), plus the per-patient run the
      // review was imported from, and take each agent's answer for each field
      // from the FIRST run that drafted it (most-recent wins). Locations:
      // var/runs/<run>/per_patient/<pid>/agents/<agent>.json
      const chain = state.imported_from_run ? [...runChain, state.imported_from_run] : runChain;
      const agentFieldAns: Record<string, Record<string, unknown>> = {};
      const filled = new Set<string>(); // `${agentId}::${fid}` already taken by a newer run
      for (const run of chain) {
        const agentsDir = path.join(runsDir, run, "per_patient", pid, "agents");
        if (!fs.existsSync(agentsDir)) continue;
        for (const file of fs.readdirSync(agentsDir)) {
          // Skip transcripts and B1 failure markers (<agent>.error.json) — a
          // failed agent produced no draft and must not appear in the leaderboard.
          if (!file.endsWith(".json") || file.endsWith(".error.json") || file.endsWith("_transcript.jsonl")) continue;
          const agentId = file.replace(/\.json$/, "");
          const draft = readJson<{ field_assessments?: FieldAssessment[] }>(path.join(agentsDir, file));
          if (!draft) continue;
          for (const fa of draft.field_assessments ?? []) {
            if (!decidedFields.includes(fa.field_id)) continue;
            const key = `${agentId}::${fa.field_id}`;
            if (filled.has(key)) continue; // a more-recent run already supplied this field
            filled.add(key);
            (agentFieldAns[agentId] ??= {})[fa.field_id] = fa.answer;
          }
        }
      }

      for (const [agentId, fieldAns] of Object.entries(agentFieldAns)) {
        let scoredAny = false;
        for (const fid of decidedFields) {
          if (!(fid in fieldAns)) continue; // this agent never answered this field
          const cell = ensure(agentId, fid);
          cell.n_evaluable += 1;
          if (answersEqual(fieldAns[fid], humanFinal[fid])) cell.n_correct += 1;
          scoredAny = true;
        }
        if (scoredAny) {
          agentIds.add(agentId);
          validatedPatients.add(pid); // counted once per patient with ≥1 scored field
        }
      }
    }
  }

  const agents = [...agentIds].sort().map((agentId) => {
    const per_field = primaryCriterionIds.map((fid) => {
      const c = agentCounts[agentId]?.[fid] ?? { n_evaluable: 0, n_correct: 0 };
      return {
        field_id: fid,
        n_evaluable: c.n_evaluable,
        n_correct: c.n_correct,
        accuracy: c.n_evaluable === 0 ? null : c.n_correct / c.n_evaluable,
      };
    });
    const scored = per_field.filter((c) => c.accuracy != null);
    const avg_accuracy =
      scored.length === 0 ? null : scored.reduce((s, c) => s + (c.accuracy as number), 0) / scored.length;
    return { agent_id: agentId, per_field, avg_accuracy };
  });

  return {
    task_id: taskId,
    n_patients: validatedPatients.size,
    field_ids: primaryCriterionIds,
    agents,
  };
}

export const performanceRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/performance/:taskId",
    handler: async (_b, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) {
        const err = new Error(`task ${p.taskId} not found`) as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const primaryCriterionIds = task.fields.map(
        (f) => (f as { field_id?: string; id?: string }).field_id ?? (f as { id: string }).id,
      );
      const sessionId = query.get("session_id");
      if (!sessionId) {
        const err = new Error("session_id is required") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      if (query.get("per_note") === "1") {
        const { computePerNotePerformance } = await import("./lib/pernote-performance.js");
        return computePerNotePerformance(sessionId, p.taskId, primaryCriterionIds);
      }
      // Optional iter_id → score that specific run (the run-tab selection);
      // absent → latest iter's run.
      const iterId = query.get("iter_id");
      const runOverride = iterId
        ? (listPilotIterations(p.taskId).find((i) => i.iter_id === iterId)?.run_id ?? null)
        : null;
      return computePerformance(sessionId, p.taskId, primaryCriterionIds, runOverride);
    },
  },
];
