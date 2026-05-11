// M6.3 — jobs queue, viewer tokens, guideline diff/versions, and the
// patient-import POST. Each was a one-off `app.get/post(...)` in v1's
// server.ts; grouped here because they're small, unrelated to the
// bigger feature surfaces, and all read-mostly.
//
// Endpoints:
//   GET    /api/jobs                          — list jobs
//   GET    /api/jobs/:jobId                   — manifest + status
//   GET    /api/jobs/:jobId/transcript        — append-only stream
//   POST   /api/auth/viewer-token             — issue (requires auth)
//   GET    /api/auth/viewer-tokens            — list (requires auth)
//   DELETE /api/auth/viewer-tokens/:token     — revoke (requires auth)
//   GET    /api/diff/:taskId                  — compute guideline diff
//   POST   /api/runs/:runId/patients/:patientId/import — import agent draft

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { readReviewerFromRequest } from "./auth.js";
import {
  listJobs, getJobManifest, getJobStatus, readJobTranscript,
  type JobKind,
} from "../../chart-review-platform/app/server/jobs.js";
import {
  issueViewerToken, listViewerTokens, revokeViewerToken,
} from "../../chart-review-platform/app/server/auth.js";
import { loadVersionedTask } from "../../chart-review-platform/app/server/version-archive.js";
import { computeTaskDiff } from "../../chart-review-platform/app/server/task-diff.js";
import {
  getRunManifest,
} from "../../chart-review-platform/app/server/infra/batch-run/index.js";

function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT
    ?? path.resolve(process.cwd(), "..", "chart-review-platform");
}
function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(platformRoot(), "var", "reviews");
}
function runsRoot(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(platformRoot(), "var", "runs");
}

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function requireAuth(req: Parameters<RouteEntry["handler"]>[1]): string {
  const reviewerId = readReviewerFromRequest(req);
  if (!reviewerId) throw httpErr(401, "authentication required");
  return reviewerId;
}

export const jobsRoutes: RouteEntry[] = [
  // ── /api/jobs/* ─────────────────────────────────────────────────────
  {
    method: "GET", pattern: "/api/jobs",
    handler: async (_b, _r, _p, query) => {
      const kind = query.get("kind") ?? undefined;
      const task_id = query.get("task_id") ?? undefined;
      const limitStr = query.get("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;
      return listJobs({ kind: kind as JobKind | undefined, task_id, limit });
    },
  },
  {
    method: "GET", pattern: "/api/jobs/:jobId",
    handler: async (_b, _r, p) => {
      const m = getJobManifest(p.jobId);
      const s = getJobStatus(p.jobId);
      if (!m || !s) throw httpErr(404, "job not found");
      return { manifest: m, status: s };
    },
  },
  {
    method: "GET", pattern: "/api/jobs/:jobId/transcript",
    handler: async (_b, _r, p, query) => {
      const sinceLineRaw = query.get("since");
      const sinceLine = sinceLineRaw ? parseInt(sinceLineRaw, 10) : 0;
      return readJobTranscript(p.jobId, { sinceLine: isNaN(sinceLine) ? 0 : sinceLine });
    },
  },

  // ── /api/auth/viewer-token + /viewer-tokens ─────────────────────────
  {
    method: "POST", pattern: "/api/auth/viewer-token",
    handler: async (body, req) => {
      const reviewerId = requireAuth(req);
      const { task_id, expires_in_days } = (body ?? {}) as {
        task_id?: string; expires_in_days?: number;
      };
      if (!task_id) throw httpErr(400, "task_id required");
      const v = issueViewerToken(task_id, expires_in_days ?? 30, reviewerId);
      // Best-effort URL: rewrite the API port to Vite's dev port.
      const host = req.headers.host ?? "localhost:3002";
      const viewerHost = host.replace(":3002", ":5174").replace(":3001", ":5173");
      const url = `http://${viewerHost}/methodologist/${task_id}?viewer=${v.token}`;
      return { ok: true, ...v, url };
    },
  },
  {
    method: "GET", pattern: "/api/auth/viewer-tokens",
    handler: async (_b, req) => {
      requireAuth(req);
      return listViewerTokens();
    },
  },
  {
    method: "DELETE", pattern: "/api/auth/viewer-tokens/:token",
    handler: async (_b, req, p) => {
      requireAuth(req);
      return { ok: revokeViewerToken(p.token) };
    },
  },

  // ── /api/diff/:taskId ───────────────────────────────────────────────
  {
    method: "GET", pattern: "/api/diff/:taskId",
    handler: async (_b, _r, p, query) => {
      const from = query.get("from");
      const to = query.get("to");
      if (!from || !to) {
        const err = httpErr(400, "from and to query params required");
        (err as Error & { payload?: unknown }).payload = { ok: false };
        throw err;
      }
      const fromTask = loadVersionedTask(p.taskId, from);
      const toTask = loadVersionedTask(p.taskId, to);
      if (!fromTask || !toTask) {
        const err = httpErr(404, "version not found");
        (err as Error & { payload?: unknown }).payload = { ok: false };
        throw err;
      }
      return computeTaskDiff(fromTask, toTask, from, to);
    },
  },

  // ── /api/runs/:runId/patients/:patientId/import ─────────────────────
  // Refuses to overwrite an existing review_state unless force:true.
  // Vendored from server.ts so v2 can ingest agent drafts without v1.
  {
    method: "POST", pattern: "/api/runs/:runId/patients/:patientId/import",
    handler: async (body, _req, p) => {
      const force = (body as { force?: boolean })?.force === true;
      const manifest = getRunManifest(p.runId);
      if (!manifest) throw httpErr(404, "run not found");

      const draftPath = path.join(runsRoot(), p.runId, "per_patient", p.patientId, "agent_draft.json");
      if (!fs.existsSync(draftPath)) {
        throw httpErr(404, "draft not found for this patient in this run");
      }

      const taskId = manifest.task_id;
      const reviewStatePath = path.join(reviewsRoot(), p.patientId, taskId, "review_state.json");
      if (fs.existsSync(reviewStatePath) && !force) {
        const err = httpErr(409, "review_state already exists for this patient×task; pass force:true to overwrite");
        (err as Error & { payload?: unknown }).payload = { ok: false };
        throw err;
      }

      const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
      fs.mkdirSync(path.dirname(reviewStatePath), { recursive: true });
      fs.writeFileSync(reviewStatePath, JSON.stringify({
        patient_id: p.patientId,
        task_id: taskId,
        review_status: "agent_drafted",
        field_assessments: draft.field_assessments ?? [],
        imported_from_run: p.runId,
        imported_at: new Date().toISOString(),
      }, null, 2));
      return { ok: true, imported_to: reviewStatePath };
    },
  },
];
