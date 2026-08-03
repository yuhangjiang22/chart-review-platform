/**
 * Best-effort iter-state side-effect: transition the active pilot iter to
 * "validating" when the first reviewer field_assessment is committed.
 *
 * Kept in its own file (separate from pilots.ts) so the vitest mock for
 * "../domain/iter/index.js" correctly intercepts `listPilotIterations` and
 * `setPilotState` calls made here. pilots.ts re-exports this function so
 * external callers see it from either path.
 */

import { listPilotIterations, setPilotState } from "./index.js";

/**
 * Best-effort side-effect: when a reviewer commits their FIRST field
 * assessment on a task, transition the most-recent running/ready_to_validate
 * iter to "validating". Wraps errors so callers are never broken.
 *
 * `reviewerAssessmentCountForPatient` is the count of reviewer-source
 * assessments visible in the review state AFTER the current write. A value
 * of 1 means this is the first reviewer cell on this patient. setPilotState
 * is idempotent for the same target value, so duplicate calls are safe.
 *
 * Called from applyUiAction's side-effect chain in review-state.ts.
 */
export function maybeTransitionIterToValidating(
  taskId: string,
  _patientId: string,
  _fieldId: string,
  reviewerAssessmentCountForPatient: number,
): void {
  try {
    if (reviewerAssessmentCountForPatient !== 1) return;
    const iters = listPilotIterations(taskId);
    // listPilotIterations returns newest-first.
    const target = iters.find(
      (i) => i.state === "running" || i.state === "ready_to_validate",
    );
    if (!target) return;
    setPilotState(taskId, target.iter_id, "validating");
  } catch {
    // Best-effort — never propagate
  }
}
