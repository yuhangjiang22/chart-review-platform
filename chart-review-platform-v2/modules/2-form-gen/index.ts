// Module 2: Form / guideline generation.
//
// Turns a TaskSpec into a FormSpec — the criteria list the extractors
// will fill. The chart-review side has the richer pattern (atomic
// criteria + schema_hash + applicability + derivation); lit-extract
// uses the same shape with simpler criteria.
//
// Both adapters compute schema_hash so the next iteration of refinement
// can carry-forward unchanged criteria's prior answers + adjudications.

export type { FormGenModule, FormSpec, Criterion } from "../../shared/types.js";

export { makeChartReviewFormGen } from "./chart-review.js";
export { makeLitExtractFormGen } from "./lit-extract.js";
