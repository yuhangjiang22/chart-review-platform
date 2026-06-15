// Package routes — named rubric snapshots derived from sessions.
//
// GET    /api/packages/:taskId                     — list all packages
// GET    /api/packages/:taskId/:packageId          — one package's manifest
// POST   /api/packages/:taskId                     — generate from active session
// POST   /api/packages/:taskId/:packageId/apply    — restore to live skill
// DELETE /api/packages/:taskId/:packageId          — remove package
//
// Generation is non-destructive: it snapshots the live references/
// subtree at the moment of the call. Apply IS destructive: it
// replaces the live references/ with the snapshot. Both are
// methodologist-gated.

import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import {
  createPackage,
  applyPackage,
  deletePackage,
  getPackageManifest,
  listPackages,
  getSessionManifest,
} from "./lib/domain/iter/index.js";
import type { AgentSpec } from "@chart-review/agent-specs";

function gateMethodologist(
  req: Parameters<RouteEntry["handler"]>[1],
  action: string,
): string {
  const reviewerId = readReviewerFromRequest(req);
  if (reviewerId === null) {
    const err = new Error("Authorization required. POST /api/auth/login first.") as Error & { status: number };
    err.status = 401;
    throw err;
  }
  if (!isMethodologist(reviewerId)) {
    const err = new Error(`methodologist privilege required to ${action}`) as Error & { status: number };
    err.status = 403;
    throw err;
  }
  return reviewerId;
}

function isValidTaskId(s: string): boolean {
  return /^[a-z][a-z0-9-]+$/.test(s);
}

export const packageRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/packages/:taskId",
    handler: async (_b, _r, p) => {
      if (!isValidTaskId(p.taskId)) {
        const err = new Error("invalid task_id") as Error & { status: number };
        err.status = 400; throw err;
      }
      return { packages: listPackages(p.taskId) };
    },
  },

  {
    method: "GET",
    pattern: "/api/packages/:taskId/:packageId",
    handler: async (_b, _r, p) => {
      if (!isValidTaskId(p.taskId)) {
        const err = new Error("invalid task_id") as Error & { status: number };
        err.status = 400; throw err;
      }
      const m = getPackageManifest(p.taskId, p.packageId);
      if (!m) {
        const err = new Error("package not found") as Error & { status: number };
        err.status = 404; throw err;
      }
      return { package: m };
    },
  },

  {
    method: "POST",
    pattern: "/api/packages/:taskId",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "generate a package");
      if (!isValidTaskId(p.taskId)) {
        const err = new Error("invalid task_id") as Error & { status: number };
        err.status = 400; throw err;
      }
      const { name, description, source_session_id, calibration_summary } = (body ?? {}) as {
        name?: string;
        description?: string;
        source_session_id?: string | null;
        calibration_summary?: Record<string, unknown> | null;
      };
      if (!name || typeof name !== "string" || name.trim().length === 0) {
        const err = new Error("name is required") as Error & { status: number };
        err.status = 400; throw err;
      }
      // If a source_session_id is provided, validate it exists and pull
      // its agent_specs into the package so a future "start from package"
      // can pre-fill the new session's agent config.
      let agentSpecs: AgentSpec[] | undefined;
      let resolvedSourceId: string | null = null;
      if (source_session_id && typeof source_session_id === "string") {
        const session = getSessionManifest(p.taskId, source_session_id);
        if (!session) {
          const err = new Error(`source session not found: ${source_session_id}`) as Error & { status: number };
          err.status = 400; throw err;
        }
        agentSpecs = session.agent_specs ?? session.default_agent_specs;
        resolvedSourceId = source_session_id;
      }
      try {
        const m = createPackage({
          task_id: p.taskId,
          name,
          description,
          generated_by: reviewerId,
          source_session_id: resolvedSourceId,
          agent_specs: agentSpecs,
          calibration_summary: calibration_summary ?? null,
        });
        return { package: m };
      } catch (e) {
        const err = new Error((e as Error).message) as Error & { status: number };
        err.status = 400; throw err;
      }
    },
  },

  {
    method: "POST",
    pattern: "/api/packages/:taskId/:packageId/apply",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "apply a package");
      if (!isValidTaskId(p.taskId)) {
        const err = new Error("invalid task_id") as Error & { status: number };
        err.status = 400; throw err;
      }
      try {
        const m = applyPackage(p.taskId, p.packageId);
        return { package: m, applied: true };
      } catch (e) {
        const status = (e as Error).message.startsWith("package not found") ? 404 : 400;
        const err = new Error((e as Error).message) as Error & { status: number };
        err.status = status; throw err;
      }
    },
  },

  {
    method: "DELETE",
    pattern: "/api/packages/:taskId/:packageId",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "delete a package");
      if (!isValidTaskId(p.taskId)) {
        const err = new Error("invalid task_id") as Error & { status: number };
        err.status = 400; throw err;
      }
      const ok = deletePackage(p.taskId, p.packageId);
      if (!ok) {
        const err = new Error("package not found") as Error & { status: number };
        err.status = 404; throw err;
      }
      return { deleted: true };
    },
  },
];
