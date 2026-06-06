/**
 * Reviewer authentication. Two modes via env:
 *
 *   REVIEWER_AUTH=optional (default)   any reviewer_id is accepted;
 *                                      identity is captured for audit
 *   REVIEWER_AUTH=required             reviewer_id must be in REVIEWERS
 *                                      (comma-separated env var)
 *
 * Tokens are opaque random strings stored in an in-memory Map. There
 * is no crypto here — the platform is local-only by default. For a
 * production deployment behind real PHI, swap this for SSO + signed
 * tokens at the gateway.
 *
 * Token transport:
 *   REST:  Authorization: Bearer <token>
 *   WS:    ?token=<token> query param on the upgrade URL (browsers
 *          can't easily set headers on the WebSocket constructor)
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Request, Response, NextFunction } from "express";

// __dirname is not defined in ESM; derive from import.meta.url so the
// reviews-root fallback resolves when CHART_REVIEW_REVIEWS_ROOT isn't set.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type AuthMode = "optional" | "required";

interface SessionRecord {
  reviewer_id: string;
  issued_at: string;
  last_seen_at: string;
}

const MODE: AuthMode =
  (process.env.REVIEWER_AUTH as AuthMode) === "required"
    ? "required"
    : "optional";

const ALLOWLIST = (process.env.REVIEWERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Reviewer ids that may also act as methodologists (read methodologist
 * surfaces without issuing themselves a viewer token). Empty allowlist =
 * any *authenticated* reviewer is treated as a methodologist (the
 * anonymous-reviewer fallback is never methodologist).
 */
const METHODOLOGIST_ALLOWLIST = (process.env.METHODOLOGISTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function methodologistAllowlist(): string[] {
  return [...METHODOLOGIST_ALLOWLIST];
}

export function isMethodologist(reviewerId: string | null | undefined): boolean {
  if (!reviewerId || reviewerId === "anonymous-reviewer") return false;
  if (METHODOLOGIST_ALLOWLIST.length === 0) return true;
  return METHODOLOGIST_ALLOWLIST.includes(reviewerId);
}

const sessions = new Map<string, SessionRecord>();

function makeToken(): string {
  return randomBytes(24).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

export function authMode(): AuthMode {
  return MODE;
}

export function reviewerAllowlist(): string[] {
  return [...ALLOWLIST];
}

export interface LoginResult {
  ok: boolean;
  token?: string;
  reviewer_id?: string;
  mode: AuthMode;
  error?: string;
}

export function login(reviewerId: string): LoginResult {
  const id = (reviewerId ?? "").trim();
  if (!id) return { ok: false, mode: MODE, error: "reviewer_id required" };
  if (!/^[a-zA-Z0-9_.@-]+$/.test(id)) {
    return {
      ok: false,
      mode: MODE,
      error: "reviewer_id may only contain letters, digits, _ . @ -",
    };
  }
  if (MODE === "required" && !ALLOWLIST.includes(id)) {
    return {
      ok: false,
      mode: MODE,
      error: `reviewer "${id}" is not on the allowlist`,
    };
  }
  const token = makeToken();
  sessions.set(token, {
    reviewer_id: id,
    issued_at: nowIso(),
    last_seen_at: nowIso(),
  });
  return { ok: true, token, reviewer_id: id, mode: MODE };
}

export function logout(token: string): boolean {
  return sessions.delete(token);
}

/** Resolve a Bearer token to a reviewer_id. Updates last_seen_at. */
export function resolveToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const rec = sessions.get(token);
  if (!rec) return null;
  rec.last_seen_at = nowIso();
  return rec.reviewer_id;
}

function readTokenFromRequest(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  // Fallback for in-browser GETs that can't easily set headers (e.g. when
  // returning from a redirect): allow ?token=… on the URL.
  if (typeof req.query.token === "string") return req.query.token;
  return null;
}

/**
 * Express middleware. In optional mode, attaches a reviewer_id to the
 * request (from token if present, else "anonymous-reviewer") and lets
 * the request through. In required mode, rejects unauthenticated
 * requests with 401.
 */
export function authMiddleware(opts?: { requireAuth?: boolean }) {
  const requireAuth = opts?.requireAuth ?? false;
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readTokenFromRequest(req);
    const reviewerId = resolveToken(token);
    if (reviewerId) {
      (req as any).reviewer_id = reviewerId;
      (req as any).auth_token = token;
      return next();
    }
    if (MODE === "required" || requireAuth) {
      return res.status(401).json({
        ok: false,
        error_code: "unauthenticated",
        message: "Authorization required. POST /api/auth/login first.",
      });
    }
    (req as any).reviewer_id = "anonymous-reviewer";
    return next();
  };
}

export function reviewerIdOf(req: Request): string {
  return ((req as any).reviewer_id as string) || "anonymous-reviewer";
}

// ---------------------------------------------------------------------------
// Viewer-token machinery
// ---------------------------------------------------------------------------

/** Always re-read the env var so tests can override it without resetting
 *  the module. Falls back to `<platform-root>/var/reviews/`, matching the
 *  same pattern used in review-state.ts. */
function reviewsRoot(): string {
  return (
    process.env.CHART_REVIEW_REVIEWS_ROOT ??
    path.join(path.dirname(path.dirname(path.dirname(__dirname))), "var", "reviews")
  );
}

export interface ViewerToken {
  token: string;
  task_id: string;
  expires_at: string;
  issued_by: string;
  issued_at: string;
}

// In-memory map; persisted to disk on every change.
const viewerTokens = new Map<string, ViewerToken>();
let viewerTokensLoaded = false;

function viewerTokensFile(): string {
  return path.join(reviewsRoot(), "_auth", "viewer-tokens.json");
}

function ensureViewerTokensLoaded(): void {
  if (viewerTokensLoaded) return;
  viewerTokensLoaded = true;
  const f = viewerTokensFile();
  if (!fs.existsSync(f)) return;
  try {
    const data = JSON.parse(fs.readFileSync(f, "utf8")) as ViewerToken[];
    for (const t of data) {
      if (new Date(t.expires_at).getTime() > Date.now()) {
        viewerTokens.set(t.token, t);
      }
    }
  } catch {
    // ignore malformed
  }
}

function persistViewerTokens(): void {
  const f = viewerTokensFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify([...viewerTokens.values()], null, 2));
}

export function issueViewerToken(
  taskId: string,
  expiresInDays: number,
  issuedBy: string,
): ViewerToken {
  ensureViewerTokensLoaded();
  const token = randomBytes(24).toString("hex");
  const now = Date.now();
  const v: ViewerToken = {
    token,
    task_id: taskId,
    issued_by: issuedBy,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
  };
  viewerTokens.set(token, v);
  persistViewerTokens();
  return v;
}

export function listViewerTokens(): ViewerToken[] {
  ensureViewerTokensLoaded();
  return [...viewerTokens.values()];
}

export function revokeViewerToken(token: string): boolean {
  ensureViewerTokensLoaded();
  const removed = viewerTokens.delete(token);
  if (removed) persistViewerTokens();
  return removed;
}

export function resolveViewerToken(token: string): ViewerToken | null {
  ensureViewerTokensLoaded();
  const v = viewerTokens.get(token);
  if (!v) return null;
  if (new Date(v.expires_at).getTime() < Date.now()) {
    viewerTokens.delete(token);
    persistViewerTokens();
    return null;
  }
  return v;
}

export function viewerAuthMiddleware() {
  return (
    req: Request & { viewer_task_id?: string; reviewer_id?: string },
    res: Response,
    next: NextFunction,
  ) => {
    const urlTaskId = (req.params as { task_id?: string })?.task_id;

    // Path A: explicit viewer token (?viewer=… or Bearer <viewer-token>)
    // for read-only external collaborators.
    const queryToken = (req.query?.viewer as string) ?? null;
    const headerToken =
      (req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "") || null;
    const candidateToken = queryToken ?? headerToken;
    if (candidateToken) {
      const v = resolveViewerToken(candidateToken);
      if (v) {
        if (urlTaskId && urlTaskId !== v.task_id) {
          return res
            .status(403)
            .json({ ok: false, error: "viewer token bound to a different task_id" });
        }
        req.viewer_task_id = v.task_id;
        return next();
      }
      // Token didn't resolve as a viewer token — fall through to Path B
      // in case it's a regular reviewer session token.
    }

    // Path B: logged-in reviewer with methodologist privilege.
    const sessionReviewerId = resolveToken(headerToken);
    if (sessionReviewerId && isMethodologist(sessionReviewerId)) {
      req.reviewer_id = sessionReviewerId;
      if (urlTaskId) req.viewer_task_id = urlTaskId;
      return next();
    }

    return res.status(401).json({
      ok: false,
      error: candidateToken
        ? "invalid or expired viewer token, and no methodologist session"
        : "viewer token or methodologist session required",
    });
  };
}

/** Reset in-memory viewer-token state. Only for tests. */
export function _resetViewerTokensForTest(): void {
  viewerTokens.clear();
  viewerTokensLoaded = false;
}
