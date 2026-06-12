// refine-routes.ts — self-refinement (Task S1, read-only).
//
// GET /api/refine/:taskId/:iterId/candidates?session_id=
//   → the attributed, clustered agent-vs-human disagreement set (the ① data of
//     the proposal card). Session-scoped (session_id required, like the other
//     review routes). Gates on phenotype task_kind — NER/adherence return an
//     `unsupported` marker (later increments).
//
// No LLM calls, no writes. Mirrors computePerformance's agent-vs-human join;
// see server/lib/refine/candidates.ts.

import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "@chart-review/tasks";
import { collectRefinementCandidates } from "./lib/refine/candidates.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

export const refineRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/refine/:taskId/:iterId/candidates",
    handler: async (_b, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);

      const sessionId = query.get("session_id");
      if (!sessionId) throw httpErr(400, "session_id is required");

      const taskKind = task.task_kind ?? "phenotype";
      if (taskKind !== "phenotype") {
        // NER/adherence are later increments. Surface a 400 with an
        // `unsupported` marker rather than a silent empty result.
        throw httpErr(
          400,
          `self-refinement supports phenotype tasks only; ${p.taskId} is ${taskKind}`,
        );
      }

      return collectRefinementCandidates({
        sessionId,
        taskId: p.taskId,
        iterId: p.iterId,
      });
    },
  },
];
