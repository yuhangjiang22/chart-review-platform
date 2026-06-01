/**
 * domain/iter — Pilot Iter lifecycle: the unit of calibration.
 *
 * An Iter pairs a frozen guideline_sha + dev cohort with a batch run, a
 * methodologist's adjudications, and an auto-critique that emits proposals.
 * Phase enum + transition rules live here; the on-disk manifest schema and
 * read helpers live here; the auto-critique fire path lives here.
 *
 * iter-accuracy: per-criterion accuracy report aggregated from the iter's
 * critique. Drives the "is the guideline ready to scale" decision.
 *
 * External callers should import from `./domain/iter/index.js`.
 */

export {
  // Lifecycle types
  type PilotState,
  type IterPhase,
  type IterAction,
  type PilotManifest,
  type GuidelineVersion,
  type PilotListing,
  type StartPilotOptions,
  type StartPilotResult,
  type PilotCritiqueRecord,
  type PilotIterationStats,
  // Phase transitions
  derivePhase,
  transitionPhase,
  isValidatingState,
  isRevisingState,
  isSupersededState,
  isLockedVersionState,
  // Constructors + persistence
  startPilotIteration,
  getPilotManifest,
  listPilotIterations,
  setPilotState,
  transitionIterToRevising,
  // Self-critique driver
  selfCritiquePilot,
  fireAutoCritique,
  getPilotCritique,
  // Per-iter aggregators
  pilotIterationStats,
  extractDisagreements,
  writePilotDisagreements,
  mergeDraftFieldAssessments,
  mergePilotDrafts,
  carryForwardAdjudications,
  emitDerivedArtifactsOnCompletion,
  // Helpers
  readPrimaryCriterionIds,
  snapshotCriterionHashesSync,
  // Phase-driven workspace side-effects
  maybeTransitionIterToValidating,
} from "./pilots.js";

export {
  maybeAutoAdvancePilotOnRunStatus,
  reconcilePilotStatesOnStartup,
} from "./auto-advance-on-run-complete.js";

export {
  // Per-criterion accuracy aggregator
  type PerCriterionAccuracy,
  type IterAccuracy,
  type ComputeIterAccuracyArgs,
  computeIterAccuracy,
  persistIterAccuracy,
  writeIterReport,
} from "./iter-accuracy.js";
