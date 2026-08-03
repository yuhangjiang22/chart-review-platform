// GET /api/tasks/:taskId/tools — the resolved, display-ready tool surface for a
// task: the MCP tools, structured (OMOP) read tools, and Python plugin tools the
// task exposes, each with a one-line description. Backs the "what tools does this
// task use?" panel; derived from the task's ToolProfile so it never drifts.
import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "@chart-review/tasks";
import { describeTaskTools } from "@chart-review/task-tools";

export const taskToolsRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/tasks/:taskId/tools",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) {
        const err = new Error(`unknown task ${p.taskId}`) as Error & { status: number };
        err.status = 404;
        throw err;
      }
      return describeTaskTools(task);
    },
  },
];
