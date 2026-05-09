/**
 * adapters/http/auth-routes — HTTP adapter for the auth + per-reviewer
 * notification surface.
 *
 * Auth has a hard public/protected split: login/logout/whoami must be
 * reachable WITHOUT a token (otherwise nobody could ever obtain one), while
 * the notification inbox and viewer-token management require an
 * authenticated reviewer. The split lives in two router factories so
 * server.ts can mount them either side of `app.use("/api", authMiddleware())`
 * without this file having to know about the middleware itself.
 *
 * Routes registered:
 *   publicAuthRouter()
 *     POST   /api/auth/login
 *     POST   /api/auth/logout
 *     GET    /api/auth/whoami
 *
 *   protectedAuthRouter()
 *     GET    /api/notifications
 *     GET    /api/notifications/unread-count
 *     POST   /api/notifications/mark-read
 *     POST   /api/auth/viewer-token
 *     GET    /api/auth/viewer-tokens
 *     DELETE /api/auth/viewer-tokens/:token
 */

import express, { Router } from "express";
import {
  authMode,
  login as authLogin,
  logout as authLogout,
  resolveToken,
  reviewerAllowlist,
  reviewerIdOf,
  isMethodologist,
  issueViewerToken,
  listViewerTokens,
  revokeViewerToken,
} from "../../auth.js";
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from "../../notifications.js";

/**
 * Public auth surface — must be mounted BEFORE authMiddleware so unauthenticated
 * clients can obtain or inspect a token.
 */
export function publicAuthRouter(): Router {
  const router = Router();

  router.post("/api/auth/login", (req, res) => {
    const reviewer_id = req.body?.reviewer_id;
    const result = authLogin(reviewer_id ?? "");
    res.status(result.ok ? 200 : 400).json(result);
  });

  router.post("/api/auth/logout", (req, res) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    authLogout(token);
    res.json({ ok: true });
  });

  router.get("/api/auth/whoami", (req, res) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const id = resolveToken(token);
    res.json({
      mode: authMode(),
      allowlist: authMode() === "required" ? reviewerAllowlist() : null,
      reviewer_id: id ?? null,
      authenticated: id !== null,
      is_methodologist: isMethodologist(id),
    });
  });

  return router;
}

/**
 * Protected auth + notifications surface — must be mounted AFTER
 * authMiddleware so reviewerIdOf(req) resolves to a real reviewer.
 *
 * Includes the per-reviewer notification inbox (#15) and the viewer-token
 * management endpoints (issue / list / revoke).
 */
export function protectedAuthRouter(): Router {
  const router = Router();

  // ── notifications (#15) ────────────────────────────────────────────────────
  // Per-reviewer inbox: fired when something a reviewer cares about happens
  // after they walked away (their proposal accepted/rejected, etc.).
  router.get("/api/notifications", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
    res.json(listNotifications(reviewerId, {
      unreadOnly,
      limit,
      includeMethodologistBroadcast: isMethodologist(reviewerId),
    }));
  });

  router.get("/api/notifications/unread-count", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    res.json({
      count: unreadCount(reviewerId, { includeMethodologistBroadcast: isMethodologist(reviewerId) }),
    });
  });

  router.post("/api/notifications/mark-read", express.json(), (req, res) => {
    const reviewerId = reviewerIdOf(req);
    const { ids, all } = req.body ?? {};
    if (all) markAllRead(reviewerId);
    else if (Array.isArray(ids)) markRead(reviewerId, ids);
    else return res.status(400).json({ error: "ids[] or all:true required" });
    res.json({ ok: true });
  });

  // Viewer-token endpoints (only authenticated reviewers can issue/list/revoke).
  router.post("/api/auth/viewer-token", express.json(), (req, res) => {
    const { task_id, expires_in_days } = req.body as { task_id?: string; expires_in_days?: number };
    if (!task_id) return res.status(400).json({ ok: false, error: "task_id required" });
    const reviewer_id = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";
    const v = issueViewerToken(task_id, expires_in_days ?? 30, reviewer_id);
    // Best-effort URL: rewrite the API port (3001) to the Vite dev port (5173)
    const host = req.get("host") ?? "localhost:3001";
    const viewerHost = host.replace(":3001", ":5173");
    const url = `${req.protocol}://${viewerHost}/methodologist/${task_id}?viewer=${v.token}`;
    res.json({ ok: true, ...v, url });
  });

  router.get("/api/auth/viewer-tokens", (_req, res) => {
    res.json(listViewerTokens());
  });

  router.delete("/api/auth/viewer-tokens/:token", (req, res) => {
    const { token } = req.params as { token: string };
    const ok = revokeViewerToken(token);
    res.json({ ok });
  });

  return router;
}
