/**
 * auto-role-c.ts — Threshold-based automatic Role C trigger.
 *
 * When ≥3 drift_alert entries on the same field accumulate within a 24-hour
 * window (and no role_c_auto_run for that field exists within the same 24h
 * cooldown), shouldAutoRoleC returns true.  fireAutoRoleC calls analyzeCohort
 * from feedback.ts to execute Role C for the task.
 */

import fs from "fs";
import path from "path";

const AUTO_ROLE_C_THRESHOLD = 3;
const AUTO_ROLE_C_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTO_ROLE_C_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface AutoRoleCInput {
  taskId: string;
  reviewsRoot: string;
  fieldId: string;
}

/**
 * Walk all chat/<*>.jsonl files under reviewsRoot for the given taskId,
 * count drift_alert entries for fieldId within the last 24h, and check
 * whether a role_c_auto_run cooldown entry for that field also exists in
 * the last 24h.
 *
 * Returns true iff: driftCount >= 3 AND no cooldown active.
 */
export function shouldAutoRoleC(input: AutoRoleCInput): boolean {
  const { taskId, reviewsRoot, fieldId } = input;
  if (!fs.existsSync(reviewsRoot)) return false;

  const now = Date.now();
  let driftCount = 0;
  let cooldownActive = false;

  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const chatDir = path.join(reviewsRoot, pid, taskId, "chat");
    if (!fs.existsSync(chatDir)) continue;
    for (const f of fs.readdirSync(chatDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const lines = fs
        .readFileSync(path.join(chatDir, f), "utf8")
        .split("\n")
        .filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as {
            step_type?: string;
            field_id?: string;
            ts?: string;
          };
          if (entry.field_id !== fieldId || !entry.ts) continue;
          const tsMs = new Date(entry.ts).getTime();
          if (isNaN(tsMs)) continue;

          if (
            entry.step_type === "drift_alert" &&
            now - tsMs <= AUTO_ROLE_C_WINDOW_MS
          ) {
            driftCount++;
          } else if (
            entry.step_type === "role_c_auto_run" &&
            now - tsMs <= AUTO_ROLE_C_COOLDOWN_MS
          ) {
            cooldownActive = true;
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  return driftCount >= AUTO_ROLE_C_THRESHOLD && !cooldownActive;
}

/**
 * Fire Role C for the given task. The existing Role C entry point is
 * analyzeCohort() in feedback.ts; it accepts { task_id, member_ids? }.
 * This function is intended to be called fire-and-forget (no await at the
 * call site) so the caller is never blocked.
 *
 * On completion, broadcasts a notification to every methodologist so the
 * auto-fire is no longer silent.
 */
export async function fireAutoRoleC(input: AutoRoleCInput): Promise<void> {
  const { analyzeCohort } = await import("../../../server/lib/feedback.js" as any);
  const { notifyMethodologists } = await import("../../../server/lib/notifications.js" as any);
  // input.reviewsRoot is the ambient (session-scoped) reviews root passed by
  // the mutation path — thread it so the cohort read stays inside the session.
  const result = await analyzeCohort({ task_id: input.taskId, reviewsRoot: input.reviewsRoot });
  notifyMethodologists({
    kind: "auto_role_c",
    message: result.ok
      ? `Auto Role C fired on ${input.taskId} (drift on ${input.fieldId}). ${result.member_count ?? "?"} members analyzed; ${(result.feedback as { proposals?: unknown[] })?.proposals?.length ?? 0} proposals.`
      : `Auto Role C fired on ${input.taskId} (drift on ${input.fieldId}) but failed: ${result.error}`,
    link: "/", // Studio surfaces the new feedback in CohortPanel run history
    task_id: input.taskId,
    run_id: result.run_id,
    metadata: { field_id: input.fieldId, ok: result.ok },
  });
}
