import { CohortsFigure } from "../CohortsTab";

/**
 * DEPLOY phase — thin wrapper around the existing CohortsFigure.
 * CohortsFigure manages its own task-id-less endpoint (GET /api/cohorts)
 * so no taskId prop is needed here.
 */
export function PhaseDeploy() {
  return <CohortsFigure />;
}
