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
  type ImportPilotOptions,
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
  importPilotIteration,
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

export {
  // Sessions — fixed-cohort grouping above iters
  type SessionState,
  type SessionManifest,
  type SessionListing,
  type CreateSessionInput,
  LEGACY_SESSION_ID,
  sessionsDir,
  getSessionManifest,
  listSessions,
  createSession,
  archiveSession,
  assertSessionImmutable,
  iterSessionId,
  legacySessionPlaceholder,
} from "./sessions.js";

export {
  // Packages — named, immutable rubric snapshots from a session
  type PackageManifest,
  type CreatePackageInput,
  packagesDir,
  slugifyPackageId,
  getPackageManifest,
  listPackages,
  createPackage,
  deletePackage,
  applyPackage,
} from "./packages.js";
