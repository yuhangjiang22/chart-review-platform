/**
 * Best-effort iter-state side-effect: when a batch run terminates, find the
 * pilot iter that owns it and transition state from "running" to
 * "ready_to_validate". Without this hook the iter manifest is stuck on
 * "running" forever, even though the agent finished — which makes the UI
 * badge lie and prevents the workflow phase from advancing past TRY.
 *
 * Sibling file (not inside pilots.ts) so vitest mocks for the iter index
 * intercept the listPilotIterations / setPilotState calls — same pattern as
 * validating-transition.ts.
 */

import fs from "fs";
import path from "path";
import { guidelinesRoot } from "../rubric/index.js";
import { listPilotIterations, setPilotState, getPilotManifest } from "./index.js";
import { getRunStatus } from "../../infra/batch-run/index.js";

const TERMINAL_RUN_STATES = new Set([
  "complete",
  "complete_with_errors",
  "aborted_cost_cap",
  "failed",
]);

/** Cheap list of task_ids that have a guideline directory on disk. Avoids
 *  the cost of loadSkillBundle() — we only need names. */
function listTaskIds(): string[] {
  const root = guidelinesRoot();
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith("chart-review-")) continue;
    const dir = path.join(root, name);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    out.push(name.slice("chart-review-".length));
  }
  return out;
}

/**
 * If `runState` indicates the agent run finished, find the pilot iter with
 * the matching run_id and transition `state: "running"` →
 * `"ready_to_validate"`. No-op when the run is still running, when no pilot
 * owns this run_id, or when the iter is already past "running".
 */
export function maybeAutoAdvancePilotOnRunStatus(
  runId: string,
  runState: string | null,
): void {
  if (!runState || !TERMINAL_RUN_STATES.has(runState)) return;
  try {
    for (const taskId of listTaskIds()) {
      const iters = listPilotIterations(taskId);
      const target = iters.find(
        (i) => i.run_id === runId && i.state === "running",
      );
      if (target) {
        setPilotState(taskId, target.iter_id, "ready_to_validate");
        return;
      }
    }
  } catch {
    // best-effort — never propagate
  }
}

/**
 * One-shot reconcile invoked at server startup. Catches up pilots whose
 * runs already terminated while the server was offline (or, in the demo
 * data case, were never advanced through the legacy UI).
 */
export function reconcilePilotStatesOnStartup(): void {
  try {
    for (const taskId of listTaskIds()) {
      const iters = listPilotIterations(taskId);
      for (const i of iters) {
        if (i.state !== "running") continue;
        const m = getPilotManifest(taskId, i.iter_id);
        if (!m) continue;
        const status = getRunStatus(m.run_id);
        if (!status) continue;
        if (TERMINAL_RUN_STATES.has(status.state)) {
          setPilotState(taskId, i.iter_id, "ready_to_validate");
        }
      }
    }
  } catch {
    // best-effort
  }
}
