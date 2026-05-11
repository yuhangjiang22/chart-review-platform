// Module 5: Validation / reconciliation.
//
// One shared step both workflows depend on: take N extractor outputs,
// classify cells (agreed / disagreed / type-drift / low-confidence),
// optionally pre-screen the disagreements with an LLM judge before
// they hit the human queue.
//
// Wraps v1's `disagreements.ts:compareDrafts` so the per-cell
// classification logic lives in one place across v1 and v2.

export type {
  ValidateModule, ReconciledDraft, ReconciledCell,
  ReconciliationOutcome, JudgeAnalysis,
} from "../../shared/types.js";

export { makeReconciler, type Judge } from "./reconcile.js";
export { makeV1Judge } from "./v1-judge.js";
