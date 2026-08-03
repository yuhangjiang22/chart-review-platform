// NER and adherence task scaffolding removed from platform-light.
// Phenotype tasks use the builder flow (AuthoringModeDialog / chart-review-build skill).
// This route stubs the endpoint so any stale client call gets a clear error.

import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export const scaffoldRoutes: RouteEntry[] = [
  {
    method: "POST", pattern: "/api/tasks/scaffold",
    handler: async (_body, req) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "scaffolding a task requires methodologist privilege");
      }
      // NER and adherence scaffolding removed in platform-light.
      // Phenotype tasks use the builder flow (AuthoringModeDialog).
      throw httpErr(410, "NER and adherence task scaffolding is not available in this build");
    },
  },
];
