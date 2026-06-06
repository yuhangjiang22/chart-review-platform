import { CohortsFigure } from "../CohortsTab";
import { DeployRunFolder } from "./DeployRunFolder";

/**
 * DEPLOY phase.
 *
 * For adherence (and any other task_kind the cohort manager doesn't
 * support yet) we render the simpler folder-pick deploy: the
 * methodologist types a server-side folder path of patient notes, the
 * server symlinks each subdir into the corpus, and a batch run is
 * started against the locked task.
 *
 * For phenotype we keep the existing CohortsFigure path — that pipeline
 * computes stratified-sample deployment-κ and is wired only for
 * phenotype field_assessments today.
 */
export function PhaseDeploy({
  taskId,
  taskKind,
}: {
  taskId: string;
  taskKind?: "phenotype" | "ner" | "adherence";
}) {
  if (taskKind === "adherence" || taskKind === "ner") {
    return <DeployRunFolder taskId={taskId} />;
  }
  return <CohortsFigure />;
}
