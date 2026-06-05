// Session routes — fixed-cohort grouping above iters.
//
// A session locks a cohort + agent_specs at creation time; iters started
// within that session inherit those defaults. Past sessions remain
// browsable; archiving a session marks it read-only but doesn't delete.
//
// New routes:
//   GET  /api/sessions/:taskId                       — list all sessions (+ legacy projection)
//   GET  /api/sessions/:taskId/:sessionId            — one session manifest + its iters
//   POST /api/sessions/:taskId                       — create new session
//   POST /api/sessions/:taskId/:sessionId/archive    — archive (close) a session

import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import {
  createSession,
  archiveSession,
  getSessionManifest,
  listSessions,
  legacySessionPlaceholder,
  iterSessionId,
  LEGACY_SESSION_ID,
  listPilotIterations,
  type SessionManifest,
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

interface SessionWithIters {
  session: SessionManifest;
  iter_ids: string[];
  iter_count: number;
}

function buildSessionListing(taskId: string): SessionWithIters[] {
  // Group iters by their session_id (legacy iters fall under LEGACY_SESSION_ID).
  const allIters = listPilotIterations(taskId);
  const itersBySession = new Map<string, string[]>();
  for (const it of allIters) {
    const sid = iterSessionId(it);
    if (!itersBySession.has(sid)) itersBySession.set(sid, []);
    itersBySession.get(sid)!.push(it.iter_id);
  }

  // Explicit sessions on disk.
  const sessions = listSessions(taskId);
  const out: SessionWithIters[] = sessions.map((s) => ({
    session: s,
    iter_ids: itersBySession.get(s.session_id) ?? [],
    iter_count: (itersBySession.get(s.session_id) ?? []).length,
  }));

  // Add the synthetic legacy session if any iter lacks session_id AND we
  // haven't already accounted for those iters under a real session.
  const legacyIterIds = itersBySession.get(LEGACY_SESSION_ID) ?? [];
  if (legacyIterIds.length > 0) {
    out.push({
      session: legacySessionPlaceholder(taskId),
      iter_ids: legacyIterIds,
      iter_count: legacyIterIds.length,
    });
  }
  return out;
}

export const sessionRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/sessions/:taskId",
    handler: async (_b, _r, p) => {
      if (!isValidTaskId(p.taskId)) {
        const err = new Error("invalid task_id") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      return { sessions: buildSessionListing(p.taskId) };
    },
  },

  {
    method: "GET",
    pattern: "/api/sessions/:taskId/:sessionId",
    handler: async (_b, _r, p) => {
      if (!isValidTaskId(p.taskId)) {
        const err = new Error("invalid task_id") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      // Special-case the synthetic legacy bucket.
      if (p.sessionId === LEGACY_SESSION_ID) {
        const all = buildSessionListing(p.taskId);
        const legacy = all.find((x) => x.session.session_id === LEGACY_SESSION_ID);
        if (!legacy) {
          const err = new Error("no legacy iters") as Error & { status: number };
          err.status = 404;
          throw err;
        }
        return legacy;
      }
      const m = getSessionManifest(p.taskId, p.sessionId);
      if (!m) {
        const err = new Error("session not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const all = buildSessionListing(p.taskId);
      const entry = all.find((x) => x.session.session_id === p.sessionId);
      return entry ?? { session: m, iter_ids: [], iter_count: 0 };
    },
  },

  {
    method: "POST",
    pattern: "/api/sessions/:taskId",
    handler: async (body, req, p) => {
      const reviewerId = gateMethodologist(req, "create a session");
      if (!isValidTaskId(p.taskId)) {
        const err = new Error("invalid task_id") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      const { name, patient_ids, notes, default_agent_specs } = (body ?? {}) as {
        name?: string;
        patient_ids?: string[];
        notes?: string;
        default_agent_specs?: AgentSpec[];
      };
      if (!name || typeof name !== "string" || name.trim().length === 0) {
        const err = new Error("name is required") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      if (!Array.isArray(patient_ids) || patient_ids.length === 0) {
        const err = new Error("patient_ids must be a non-empty array") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      try {
        const m = createSession({
          task_id: p.taskId,
          name,
          started_by: reviewerId,
          patient_ids,
          notes,
          default_agent_specs,
        });
        return { session: m };
      } catch (e) {
        const err = new Error((e as Error).message) as Error & { status: number };
        err.status = 400;
        throw err;
      }
    },
  },

  {
    method: "POST",
    pattern: "/api/sessions/:taskId/:sessionId/archive",
    handler: async (_b, req, p) => {
      gateMethodologist(req, "archive a session");
      if (!isValidTaskId(p.taskId)) {
        const err = new Error("invalid task_id") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      if (p.sessionId === LEGACY_SESSION_ID) {
        const err = new Error("cannot archive the synthetic legacy session") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      const m = archiveSession(p.taskId, p.sessionId);
      if (!m) {
        const err = new Error("session not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      return { session: m };
    },
  },
];
