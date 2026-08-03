/**
 * domain/issue — Production-deployment Issue queue + triage + promote-to-iter.
 *
 * Public surface (re-exports from internal files). External callers should
 * import from `./domain/issue/index.js` (or `./domain/issue/`) so the internal
 * file structure can evolve without touching call sites.
 */

export {
  // Types
  type DeploymentIssue,
  type IssueDraft,
  type TriageState,
  type TriageCategory,
  type PromotionState,
  // Operations
  appendIssue,
  appendTriageUpdate,
  appendPromotion,
  listIssues,
  // Layout helpers (used by bundle export)
  deploymentIssuesRoot,
  deploymentIssuesPath,
} from "./deployment-issues.js";
