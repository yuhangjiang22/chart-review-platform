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
) {
  const sessionDir = path.join(PLATFORM_ROOT, "var", "reviews", sessionId);
  const runsDir = path.join(PLATFORM_ROOT, "var", "runs");
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

      // imported_from_run is still needed to locate the run's agent drafts
      // for per-agent scoring (var/runs/<run>/per_patient/<pid>/agents/).
      const run = state.imported_from_run;
      if (!run) continue;
      validatedPatients.add(pid);
      const agentsDir = path.join(runsDir, run, "per_patient", pid, "agents");
      if (!fs.existsSync(agentsDir)) continue;

      for (const file of fs.readdirSync(agentsDir)) {
        // Skip transcripts and B1 failure markers (<agent>.error.json) — a
        // failed agent produced no draft and must not appear in the leaderboard.
        if (!file.endsWith(".json") || file.endsWith(".error.json") || file.endsWith("_transcript.jsonl")) continue;
        const agentId = file.replace(/\.json$/, "");
        const draft = readJson<{ field_assessments?: FieldAssessment[] }>(path.join(agentsDir, file));
        if (!draft) continue;
        agentIds.add(agentId);
        const agentAns: Record<string, unknown> = {};
        for (const fa of draft.field_assessments ?? []) agentAns[fa.field_id] = fa.answer;
        for (const fid of decidedFields) {
          if (!(fid in agentAns)) continue; // agent didn't answer this field
          const cell = ensure(agentId, fid);
          cell.n_evaluable += 1;
          if (answersEqual(agentAns[fid], humanFinal[fid])) cell.n_correct += 1;
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
      return computePerformance(sessionId, p.taskId, primaryCriterionIds);
    },
  },
];
