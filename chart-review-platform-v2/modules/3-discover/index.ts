// Module 3: Evidence discovery.
//
// Produces the corpus the extractors will read. Domain-specific:
//   - chart-review: reads patient notes from disk (one patient's cwd)
//   - lit-extract:  hits external DBs (PubMed, Europe PMC, arXiv, …)
//
// Both adapters return the same EvidenceUnit shape so step 4
// (extraction) doesn't care where the corpus came from.

export type { DiscoverModule, EvidenceUnit, SubjectRef } from "../../shared/types.js";

export { makeChartReviewDiscover } from "./chart-review.js";
export { makeLitExtractDiscover } from "./lit-extract.js";
