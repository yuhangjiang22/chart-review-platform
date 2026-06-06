// Performance report routes (light platform).
//
// GET /api/performance/:taskId — per-field agent-vs-human accuracy across
// every patient that has a validated review_state for this task. This is
// the DECIDE-phase "performance after human validation" report.
//
// Reuses computeIterAccuracy, which compares each field's agent answer
// (the original_agent_snapshot when the reviewer overrode, else the
// accepted answer) against the reviewer's final answer — read straight
// from var/reviews/<pid>/<taskId>/review_state.json. No cohort/iter
// machinery required.

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { loadCompiledTask } from "@chart-review/tasks";
import { computeIterAccuracy } from "@chart-review/domain-iter";

/** Patients with a review_state.json for this task under var/reviews/. */
function validatedPatientsForTask(taskId: string): string[] {
  const reviewsDir = path.join(PLATFORM_ROOT, "var", "reviews");
  if (!fs.existsSync(reviewsDir)) return [];
  const out: string[] = [];
  for (const pid of fs.readdirSync(reviewsDir)) {
    if (pid.startsWith(".")) continue;
    const rs = path.join(reviewsDir, pid, taskId, "review_state.json");
    if (fs.existsSync(rs)) out.push(pid);
  }
  return out.sort();
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
      const patientIds = validatedPatientsForTask(p.taskId);
      const accuracy = computeIterAccuracy({
        rootDir: path.join(PLATFORM_ROOT, "var"),
        taskId: p.taskId,
        iterId: "performance",
        cohortKind: "dev",
        patientIds,
        primaryCriterionIds,
      });
      return {
        task_id: p.taskId,
        n_patients: patientIds.length,
        per_criterion: accuracy.per_criterion,
        avg_accuracy: accuracy.avg_accuracy,
        override_count: accuracy.override_count,
        computed_at: accuracy.computed_at,
      };
    },
  },
];
