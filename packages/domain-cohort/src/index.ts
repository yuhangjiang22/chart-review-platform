/**
 * domain/cohort — Deployment Cohort: a frozen patient set against a locked
 * guideline. The Cohort concept owns its manifest + run, the stratified
 * sample drawer, and the per-patient validation pipeline that lets a
 * methodologist accept/override the agent's answers and emit κ.
 *
 * External callers should import from `./domain/cohort/index.js`.
 */

// cohorts: manifest + run management
export {
  type CohortManifest,
  type CohortRunManifest,
  type DefineCohortOptions,
  type StartCohortRunOptions,
  cohortsRoot,
  cohortDir,
  cohortManifestPath,
  cohortRunDir,
  defineCohort,
  listCohorts,
  getCohortManifest,
  listCohortRuns,
  startCohortRun,
} from "./cohorts.js";

// cohort-stratified-sampling: drawer that produces a representative sample
export {
  type SampleStrategy,
  type StratifiedSampleResult,
  drawStratifiedSample,
} from "./cohort-stratified-sampling.js";

// cohort-validation: per-patient reviewer validation persistence + queue
export {
  cohortValidationsDir,
  cohortValidationPatientDir,
  cohortValidationStatePath,
  cohortValidationReviewsRoot,
  type SampleSelection,
  readSelection,
  readValidationState,
  writeValidationState,
  type ValidationStatus,
  type PatientValidationStatus,
  computeValidationStatus,
  blindDraft,
  readCohortAgentDraft,
  type SampleQueueEntry,
  type SampleQueueResponse,
  buildSampleQueue,
} from "./cohort-validation.js";

// cohort-sampling: dev/lock split for the calibration phase
export {
  type CohortSampling,
  readCohortSampling,
  writeCohortSampling,
  defaultCohortSizes,
  registerCohortSamplingRoutes,
} from "./cohort-sampling.js";
