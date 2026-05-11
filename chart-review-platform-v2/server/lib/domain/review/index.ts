/**
 * domain/review — Reviewer's per-patient assessment state, the UiAction
 * union that mutates it, and the request-scoped reviews-root override
 * that lets the cohort-validation pipeline write into a separate tree.
 *
 * The pure transition core (transitionReviewState) lives alongside the
 * I/O-and-side-effect wrapper (applyUiAction) — both are exported so
 * tests can drive the pure core without fixture seeding.
 *
 * External callers should import from `./domain/review/index.js`.
 */

export {
  REVIEWS_ROOT,
  withReviewsRoot,
  // Types
  type AssessmentStatus,
  type AssessmentSource,
  type EditReason,
  type OriginalAgentSnapshot,
  type FieldAssessment,
  type Encounter,
  type ReviewSummary,
  type SelectedEvidence,
  type KeywordSuggestions,
  type ReviewState,
  type SetAssessmentInput,
  type SetAssessmentResult,
  type SelectEvidenceInput,
  type SetReviewStatusInput,
  type UiAction,
  type ApplyUiActionResult,
  type TransitionResult,
  // Errors
  ReviewStateError,
  // Persistence
  loadOrCreate,
  writeReviewState,
  load,
  mutate,
  // Pure transition core + atomic ops
  transitionReviewState,
  applySetAssessment,
  applySetSummary,
  applySelectEvidence,
  clearSelectedEvidence,
  applyRecommendKeywords,
  resetReviewState,
  // Side-effect wrappers
  applyUiAction,
  verifyFaithfulnessForAction,
  recomputeAlerts,
  checkDriftAfterAction,
  maybeFireAutoRoleC,
} from "./review-state.js";

export {
  getReviewsRootOverride,
} from "./reviews-context.js";
