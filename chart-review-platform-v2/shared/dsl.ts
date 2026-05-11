// DSL evaluator for applicability + derivation expressions.
//
// Re-exports v1's safeEval + applicability + derivation machinery
// verbatim so v2 doesn't reimplement them. (Python side has a parity
// copy in lib/chart_review/derivation.py; v1's CLAUDE.md gotcha #2
// explains the parity-test guard.)

export {
  safeEval,
  fieldApplicability,
  evalDerivation,
  gateReferencedIds,
  derivedInputs,
  type Env,
  type Applicability,
  type TaskField,
  type MinimalTask,
} from "../../chart-review-platform/app/server/contract-eval.js";
