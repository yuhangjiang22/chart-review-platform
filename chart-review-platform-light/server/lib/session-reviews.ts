// session-reviews.ts — session-scoped review locations. One responsibility:
// turn a workspace session id (and optionally a run id) into the directory /
// review-state root for that session. See the session-isolated-review-state spec.
import path from "node:path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { listPilotIterations } from "./domain/iter/index.js";

/** The reviews root for one session: <root>/var/reviews/<sessionId>.
 *  Pass to withReviewsRoot() to scope domain-review reads/writes. */
export function sessionReviewsRoot(sessionId: string): string {
  return path.join(PLATFORM_ROOT, "var", "reviews", sessionId);
}

/** The session a run belongs to (iter manifests carry session_id + run_id).
 *  Returns null if no iter references the run. */
export function sessionIdForRun(taskId: string, runId: string): string | null {
  const iter = listPilotIterations(taskId).find((i) => i.run_id === runId);
  return iter?.session_id ?? null;
}
