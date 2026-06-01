// Module 1: Task clarification.
//
// Turns a free-form user prompt into a TaskSpec. Adapter per domain:
//   - chart-review.ts: phenotype scope (population, condition, lookback)
//   - lit-extract.ts:  PICO scope (population, intervention, comparator, outcome)
//
// The MVP adapters are minimal: they accept a structured input rather
// than running a real LLM interview. The point is the contract — a
// real implementation could be a chat-driven Phase-1-style interview.

export type { ClarifyModule, ClarifyOptions, TaskSpec, Domain } from "@chart-review/v2-shared";

export { makeChartReviewClarify } from "./chart-review.js";
export { makeLitExtractClarify } from "./lit-extract.js";
