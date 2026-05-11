// M6.5 — Authoring wizard (drafts), codify pipeline, builder routes.
//
// Endpoints:
//   POST   /api/authoring/draft               — start a job; returns job_id
//   GET    /api/authoring/drafts              — list drafts
//   GET    /api/authoring/drafts/:taskId      — read one (text/markdown)
//   POST   /api/authoring/promote/:taskId     — promote draft → live guideline
//   POST   /api/guideline-codify/:taskId      — codify-pipeline run
//
// startDraftJob takes a broadcaster callback so the UI can stream
// transcript updates over WebSocket. v2 doesn't yet own the WS
// broadcaster (proxied to v1 by server/index.ts), so we pass a no-op
// stub for now — clients can fall back to polling
// GET /api/jobs/:jobId/transcript. When /ws/* is ported (M6.7) we'll
// swap in the real broadcaster.

import type { RouteEntry } from "./router.js";
import { readReviewerFromRequest } from "./auth.js";
import type { RawBody } from "./core-routes.js";
import {
  listDrafts, readDraft, promoteDraft, startDraftJob,
} from "./lib/authoring.js";
import {
  isCodifyError, runCodify,
} from "./lib/codify.js";

function httpErr(status: number, message: string, payload?: unknown): Error & { status: number; payload?: unknown } {
  const err = new Error(message) as Error & { status: number; payload?: unknown };
  err.status = status;
  if (payload) err.payload = payload;
  return err;
}

function noopBroadcast(_jobId: string): void {
  // No-op until v2 owns the WS broadcaster (M6.7).
}

export const authoringRoutes: RouteEntry[] = [
  // POST /api/authoring/draft — async job
  {
    method: "POST", pattern: "/api/authoring/draft",
    handler: async (body, req) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const { task_id, objective, references } = (body ?? {}) as {
        task_id?: string; objective?: string; references?: unknown;
      };
      if (!task_id || !objective) throw httpErr(400, "task_id and objective required");
      try {
        const { job_id } = startDraftJob(
          { task_id, objective, references, started_by: reviewerId } as Parameters<typeof startDraftJob>[0],
          noopBroadcast,
        );
        return { job_id };
      } catch (e) {
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  // GET /api/authoring/drafts
  {
    method: "GET", pattern: "/api/authoring/drafts",
    handler: async () => listDrafts(),
  },

  // GET /api/authoring/drafts/:taskId — text/markdown
  {
    method: "GET", pattern: "/api/authoring/drafts/:taskId",
    handler: async (_b, _r, p) => {
      const content = readDraft(p.taskId);
      if (content === null) throw httpErr(404, "draft not found");
      const body = typeof content === "string" ? content : String(content);
      const raw: RawBody = { __raw: true, contentType: "text/markdown; charset=utf-8", body };
      return raw;
    },
  },

  // POST /api/authoring/promote/:taskId
  {
    method: "POST", pattern: "/api/authoring/promote/:taskId",
    handler: async (body, _req, p) => {
      const force = (body as { force?: boolean })?.force === true;
      try {
        const result = promoteDraft({ task_id: p.taskId, force });
        if (!result.ok) throw httpErr(400, result.error ?? "promote failed", result);
        return result;
      } catch (e) {
        if ((e as { status?: number }).status) throw e;
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  // POST /api/guideline-codify/:taskId
  {
    method: "POST", pattern: "/api/guideline-codify/:taskId",
    handler: async (_b, _r, p) => {
      if (!/^[a-z][a-z0-9-]+$/.test(p.taskId)) {
        throw httpErr(400, "invalid taskId");
      }
      const result = runCodify(p.taskId);
      if (isCodifyError(result)) {
        const status =
          result.code === "missing_task" ? 404
          : result.code === "empty_cohort" ? 400
          : 500;
        throw httpErr(status, result.error, result);
      }
      return result;
    },
  },
];
