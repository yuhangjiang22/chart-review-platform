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
  importPilotIteration,
  type SessionManifest,
} from "./lib/domain/iter/index.js";
import { getRunManifest } from "./lib/infra/batch-run/index.js";
import { validateAgentSpec, type AgentSpec } from "@chart-review/agent-specs";

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
      // Accept either `agent_specs` (canonical) or `default_agent_specs`
      // (legacy alias from the pre-strict-lock era). Drop the alias once
      // all callers update.
      const { name, patient_ids, notes, agent_specs, default_agent_specs, import_run_id, per_note } = (body ?? {}) as {
        name?: string;
        patient_ids?: string[];
        notes?: string;
        agent_specs?: AgentSpec[];
        default_agent_specs?: AgentSpec[];
        /** Create the session from an EXISTING run instead of configuring a
         *  cohort to run. The session's cohort + agent are seeded from the
         *  run manifest and the run is attached as iter_001 (ready to
         *  validate). This is TRY's "import" path — no agent work is re-run. */
        import_run_id?: string;
        per_note?: boolean;
      };
      let specs = agent_specs ?? default_agent_specs;
      let resolvedPatientIds = patient_ids;
      if (!name || typeof name !== "string" || name.trim().length === 0) {
        const err = new Error("name is required") as Error & { status: number };
        err.status = 400;
        throw err;
      }

      // ── Import path: seed cohort + agent FROM the run ──────────────────
      if (import_run_id) {
        const run = getRunManifest(import_run_id);
        if (!run) {
          const err = new Error(`run not found: ${import_run_id}`) as Error & { status: number };
          err.status = 400; throw err;
        }
        if (run.task_id !== p.taskId) {
          const err = new Error(
            `run ${import_run_id} belongs to task "${run.task_id}", not "${p.taskId}"`,
          ) as Error & { status: number };
          err.status = 400; throw err;
        }
        resolvedPatientIds = run.patient_ids;
        specs = run.agent_specs ?? specs;
      }

      if (!Array.isArray(resolvedPatientIds) || resolvedPatientIds.length === 0) {
        const err = new Error("patient_ids must be a non-empty array") as Error & { status: number };
        err.status = 400;
        throw err;
      }
      // A session with no agents is unrunnable and drifts against any iter
      // that later defaults an agent ("manifest has 0, prior iter had 1"). The
      // UI dialog already requires ≥1 agent; enforce it server-side too so the
      // bare API can't create the broken state. (Import seeds specs from the run.)
      if (!Array.isArray(specs) || specs.length === 0) {
        const err = new Error(
          "agent_specs must be a non-empty array — at least one agent is required to run a session",
        ) as Error & { status: number };
        err.status = 400;
        throw err;
      }
      // Validate the specs the SAME way run-start does (preset/role_prompt
      // presence + axis), so create fails fast with a clear 400 instead of
      // succeeding into a session that can never run (the run-start error would
      // otherwise surface much later, detached from the create action).
      try {
        validateAgentSpec(specs);
      } catch (e) {
        const err = new Error((e as Error).message) as Error & { status: number };
        err.status = 400;
        throw err;
      }
      try {
        const m = createSession({
          task_id: p.taskId,
          name,
          started_by: reviewerId,
          patient_ids: resolvedPatientIds,
          notes,
          agent_specs: specs,
          per_note: per_note === true,
        });
        // Attach the existing run as this session's first iter so VALIDATE /
        // Performance light up immediately with no agent re-run.
        if (import_run_id) {
          const { pilot } = importPilotIteration({
            task_id: p.taskId,
            run_id: import_run_id,
            started_by: reviewerId,
            session_id: m.session_id,
            notes: notes ?? `Imported run ${import_run_id}`,
          });
          return { session: m, imported_iter: pilot };
        }
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
