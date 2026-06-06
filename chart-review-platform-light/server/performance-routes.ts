// Performance report routes (light platform).
//
// GET /api/performance/:taskId — per-field agent-vs-human accuracy across
// every patient the reviewer has actually validated for this task. This is
// the DECIDE-phase "performance after human validation" report.
//
// IMPORTANT: a field counts ONLY when a human has made a decision on it —
// i.e. source === "reviewer" (status "approved" or "overridden"). The agent
// run itself writes a review_state.json (its draft, source "agent" / status
// "agent_proposed"); those un-reviewed drafts must NOT be scored, or every
// field would trivially read 100% (agent compared against itself). For a
// human-decided field, the agent's answer is the original_agent_snapshot
// (captured when the reviewer touched it) and the human's answer is the
// current answer; they match iff the reviewer accepted the agent unchanged.

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
  original_agent_snapshot?: { answer?: unknown };
}
interface ReviewState {
  field_assessments?: FieldAssessment[];
}

function answersEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** A field is scored only when a human has decided it (reviewer-sourced). */
function isHumanDecided(fa: FieldAssessment): boolean {
  return fa.source === "reviewer" || fa.status === "approved" || fa.status === "overridden";
}

interface PerCriterion {
  field_id: string;
  n_evaluable: number;
  n_correct: number;
  accuracy: number | null;
}

function computePerformance(taskId: string, primaryCriterionIds: string[]) {
  const reviewsDir = path.join(PLATFORM_ROOT, "var", "reviews");
  const counts: Record<string, { evaluable: number; correct: number }> = {};
  for (const fid of primaryCriterionIds) counts[fid] = { evaluable: 0, correct: 0 };
  const validatedPatients = new Set<string>();
  let overrides = 0;

  if (fs.existsSync(reviewsDir)) {
    for (const pid of fs.readdirSync(reviewsDir)) {
      if (pid.startsWith(".")) continue;
      const rsPath = path.join(reviewsDir, pid, taskId, "review_state.json");
      if (!fs.existsSync(rsPath)) continue;
      let state: ReviewState;
      try {
        state = JSON.parse(fs.readFileSync(rsPath, "utf8")) as ReviewState;
      } catch {
        continue;
      }
      for (const fa of state.field_assessments ?? []) {
        if (!counts[fa.field_id]) continue; // not a primary criterion
        if (!isHumanDecided(fa)) continue; // skip un-reviewed agent drafts
        validatedPatients.add(pid);
        const slot = counts[fa.field_id];
        slot.evaluable += 1;
        const finalAnswer = fa.answer;
        const agentAnswer = fa.original_agent_snapshot
          ? fa.original_agent_snapshot.answer
          : fa.answer;
        if (answersEqual(agentAnswer, finalAnswer)) slot.correct += 1;
        else overrides += 1;
      }
    }
  }

  const per_criterion: PerCriterion[] = primaryCriterionIds.map((fid) => {
    const c = counts[fid];
    return {
      field_id: fid,
      n_evaluable: c.evaluable,
      n_correct: c.correct,
      accuracy: c.evaluable === 0 ? null : c.correct / c.evaluable,
    };
  });
  const scored = per_criterion.filter((c) => c.accuracy != null);
  const avg_accuracy =
    scored.length === 0 ? null : scored.reduce((s, c) => s + (c.accuracy as number), 0) / scored.length;

  return {
    task_id: taskId,
    n_patients: validatedPatients.size,
    per_criterion,
    avg_accuracy,
    override_count: overrides,
  };
}

export const performanceRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/performance/:taskId",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) {
        const err = new Error(`task ${p.taskId} not found`) as Error & { status: number };
        err.status = 404;
        throw err;
      }
      // Criterion objects carry `field_id` from the markdown frontmatter;
      // the compiled type surfaces it as `id`. Accept either.
      const primaryCriterionIds = task.fields.map(
        (f) => (f as { field_id?: string; id?: string }).field_id ?? (f as { id: string }).id,
      );
      return computePerformance(p.taskId, primaryCriterionIds);
    },
  },
];
