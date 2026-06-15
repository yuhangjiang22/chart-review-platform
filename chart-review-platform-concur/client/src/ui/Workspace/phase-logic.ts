// Phase IDs are now defined in phases.ts; re-exported here for backward
// compatibility with existing imports. The canonical list lives there.
export type { Phase } from "./phases";
import type { Phase } from "./phases";

export type MaturityState = "draft" | "piloted" | "calibrated" | "locked";

/** Iter states from the existing pilot manifest. `abandoned` is a terminal. */
export type IterStateValue =
  | "running"
  | "ready_to_validate"
  | "complete"
  | "abandoned";

export interface IterState {
  state: IterStateValue;
}

export interface CellCounts {
  /** Number of patients whose oracle_done flag is true (×criteria, approximated). */
  validated: number;
  /** Total patients × criteria (approximation for Plan A). */
  total: number;
  /** Cells that are stale due to criterion edits (from revisits endpoint). */
  stale: number;
  /** Patients in the active iter — used for human-readable labels (cells/criterion
   *  is misleading when surfaced as "N patients"). 0 when no iter exists. */
  patient_count: number;
}

export interface PhaseInfo {
  phase: Phase;
  completeness: { done: number; total: number } | null;
  status_label: string;
}

/**
 * Derive the active workflow phase from existing data.
 * Rules apply in order — first match wins.
 *
 * @param maturity   - Task's maturity state from GET /api/guidelines/:taskId/maturity
 * @param latestIter - Most recent non-abandoned iter (or null). Abandoned iters should
 *                     be filtered out before passing — pass null when all are abandoned.
 * @param cells      - Cell completeness counts (approximate in Plan A)
 * @param deployedCohortExists - True when at least one production cohort run exists
 */
export function derivePhase(
  maturity: MaturityState,
  latestIter: IterState | null,
  cells: CellCounts,
  deployedCohortExists: boolean,
): PhaseInfo {
  // Unused in the light platform (no LOCK/DEPLOY phases) — kept as a
  // parameter to preserve the call signature for existing callers.
  void maturity;
  void deployedCohortExists;

  // Treat abandoned iter same as no iter for rules 3–7
  const iter = latestIter?.state === "abandoned" ? null : latestIter;

  // Rule 3: complete + all cells fresh → DECIDE (clean)
  if (iter?.state === "complete" && cells.stale === 0 && cells.validated >= cells.total && cells.total > 0) {
    return {
      phase: "DECIDE",
      completeness: { done: cells.validated, total: cells.total },
      status_label: "validation complete",
    };
  }

  // Rule 4: complete + stale cells → DECIDE (stale)
  if (iter?.state === "complete") {
    return {
      phase: "DECIDE",
      completeness: { done: cells.validated, total: cells.total },
      status_label: "complete, stale cells",
    };
  }

  // Rule 5: ready_to_validate OR running AND any cell validated → VALIDATE (mid-flight)
  if (
    (iter?.state === "ready_to_validate" || iter?.state === "running") &&
    cells.validated > 0
  ) {
    return {
      phase: "VALIDATE",
      completeness: { done: cells.validated, total: cells.total },
      status_label: "validating",
    };
  }

  // Rule 6: running + no cell validated → TRY
  if (iter?.state === "running" && cells.validated === 0) {
    return {
      phase: "TRY",
      completeness: null,
      status_label: "running",
    };
  }

  // Rule 7: ready_to_validate + no cell validated → VALIDATE (waiting)
  if (iter?.state === "ready_to_validate" && cells.validated === 0) {
    return {
      phase: "VALIDATE",
      completeness: { done: 0, total: cells.total },
      status_label: "awaiting validation",
    };
  }

  // Rule 8: no iter or all abandoned → TRY (entry phase for the light
  // platform — task is pre-authored so the workflow opens at the run step).
  return {
    phase: "TRY",
    completeness: null,
    status_label: "ready to run",
  };
}

export type CTAAction =
  | "run-agent"
  | "open-validate"
  | "advance-decide"
  | "revise";

export interface CTADescriptor {
  label: string;
  action: CTAAction;
}

/**
 * Derive the single primary CTA for the given phase + state + cell counts.
 * For DECIDE, this returns the "Revise" option; the "Lock" CTA is always
 * shown alongside it in PhaseDecide — both are primary CTAs of equal weight.
 */
export function deriveNextCTA(
  phase: Phase,
  status_label: string,
  cells: CellCounts,
): CTADescriptor {
  // status_label is kept in the signature for future CTA differentiation.
  void status_label;
  switch (phase) {
    case "TRY":
      return {
        label: `Run agent on ${cells.patient_count} patients`,
        action: "run-agent",
      };

    case "VALIDATE": {
      const remaining = cells.total - cells.validated;
      if (remaining <= 0) {
        return { label: "All validated — continue to DECIDE", action: "advance-decide" };
      }
      return { label: "Validate next patient", action: "open-validate" };
    }

    case "DECIDE":
      // Primary CTA is Revise; the performance report is shown inline
      return { label: "Revise", action: "revise" };
  }
}
