import fs from "fs";
import path from "path";
import { computeTaskDiff } from "./task-diff.js";
import { loadVersionedTask } from "./version-archive.js";

export interface ImpactInput {
  taskId: string;
  fromSha: string;
  toSha: string;
  reviewsRoot: string;
}

export interface ImpactResult {
  total_locked: number;
  total_unlocked: number;
  affected: Array<{ patient_id: string; review_status: string; intersect_fields: string[] }>;
  unaffected: string[];
  changed_field_ids: string[];
}

const STRUCTURAL_KEYS = new Set([
  "is_applicable_when",
  "derivation",
  "answer_schema",
  "guidance_prose",
  "prompt",
]);

export function simulateImpact(input: ImpactInput): ImpactResult {
  const { taskId, fromSha, toSha, reviewsRoot } = input;
  const fromTask = loadVersionedTask(taskId, fromSha);
  const toTask = loadVersionedTask(taskId, toSha);
  const diff = computeTaskDiff(fromTask, toTask, fromSha, toSha);

  const changed = new Set<string>();
  for (const f of diff.fields) {
    if (f.status === "added" || f.status === "removed") {
      changed.add(f.field_id);
    } else if (f.status === "changed") {
      const hasStructural = (f.changes ?? []).some((c) => STRUCTURAL_KEYS.has(c.key));
      if (hasStructural) changed.add(f.field_id);
    }
  }

  const affected: Array<{ patient_id: string; review_status: string; intersect_fields: string[] }> = [];
  const unaffected: string[] = [];
  let totalLocked = 0;
  let totalUnlocked = 0;

  if (fs.existsSync(reviewsRoot)) {
    for (const pid of fs.readdirSync(reviewsRoot)) {
      if (pid.startsWith("_")) continue;
      const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
      if (!fs.existsSync(rsPath)) continue;
      try {
        const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
          review_status?: string;
          lock_task_sha?: string;
          field_assessments?: Array<{ field_id: string }>;
        };
        if (rs.review_status === "locked" && rs.lock_task_sha === fromSha) {
          totalLocked++;
          const recordFields = new Set((rs.field_assessments ?? []).map((fa) => fa.field_id));
          const intersect = [...changed].filter((f) => recordFields.has(f));
          if (intersect.length > 0) {
            affected.push({ patient_id: pid, review_status: rs.review_status, intersect_fields: intersect });
          } else {
            unaffected.push(pid);
          }
        } else {
          totalUnlocked++;
        }
      } catch { /* skip unreadable review_state.json */ }
    }
  }

  return {
    total_locked: totalLocked,
    total_unlocked: totalUnlocked,
    affected,
    unaffected,
    changed_field_ids: [...changed],
  };
}
