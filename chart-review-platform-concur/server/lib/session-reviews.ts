// session-reviews.ts — session-scoped review locations. One responsibility:
// turn a workspace session id (and optionally a run id) into the directory /
// review-state root for that session. See the session-isolated-review-state spec.
import path from "node:path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { listPilotIterations } from "./domain/iter/index.js";

/** The reviews root for one session: <reviewsRoot>/<sessionId>.
 *  Pass to withReviewsRoot() to scope domain-review reads/writes.
 *
 *  Honors CHART_REVIEW_REVIEWS_ROOT (the env var the rest of the platform
 *  reads — domain-review, storage, performance + export routes, and the
 *  platform_data_env.sh launch convention that relocates all data outside
 *  the checkout). Without this, validation writes land in
 *  PLATFORM_ROOT/var/reviews while everything else reads
 *  CHART_REVIEW_REVIEWS_ROOT — so the gold never reaches the performance
 *  report (it stays "agent_drafted" in the root the reviewer never touched). */
export function sessionReviewsRoot(sessionId: string): string {
  const reviewsRoot =
    process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
  return path.join(reviewsRoot, sessionId);
}

/** The session a run belongs to (iter manifests carry session_id + run_id).
 *  Returns null if no iter references the run. */
export function sessionIdForRun(taskId: string, runId: string): string | null {
  const iter = listPilotIterations(taskId).find((i) => i.run_id === runId);
  return iter?.session_id ?? null;
}
