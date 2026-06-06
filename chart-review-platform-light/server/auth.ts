// Reviewer authentication — vendored from v1's auth.ts.
//
// Two modes via env:
//   REVIEWER_AUTH=optional (default)   any reviewer_id is accepted;
//                                      identity is captured for audit
//   REVIEWER_AUTH=required             reviewer_id must be in REVIEWERS
//                                      (comma-separated env var)
//
// Tokens are opaque random strings stored in an in-memory Map. There
// is no crypto here — the platform is local-only by default. For a
// production deployment behind real PHI, swap this for SSO + signed
// tokens at the gateway.
//
// Token transport:
//   REST:  Authorization: Bearer <token>
//   WS:    ?token=<token> query param on the upgrade URL
//
// Source: chart-review-platform/app/server/auth.ts. Differences from v1:
//   - Express-flavored authMiddleware / reviewerIdOf / viewerAuthMiddleware
//     are replaced by Node-http-flavored readReviewerFromRequest +
//     requireMethodologist (see end of file).
//   - Viewer-tokens deferred to a later milestone.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthMode = "optional" | "required";

interface SessionRecord {
  reviewer_id: string;
  issued_at: string;
  last_seen_at: string;
}

const MODE: AuthMode =
  (process.env.REVIEWER_AUTH as AuthMode) === "required" ? "required" : "optional";

const ALLOWLIST = (process.env.REVIEWERS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const METHODOLOGIST_ALLOWLIST = (process.env.METHODOLOGISTS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function methodologistAllowlist(): string[] {
  return [...METHODOLOGIST_ALLOWLIST];
}

export function isMethodologist(reviewerId: string | null | undefined): boolean {
  // Light platform: open by default. With no METHODOLOGISTS allowlist set,
  // anyone — including anonymous reviewers — can author tasks, create
  // sessions, and start runs (a session = a new run). Set METHODOLOGISTS in
  // the env to restrict those actions to named reviewers.
  if (METHODOLOGIST_ALLOWLIST.length === 0) return true;
  if (!reviewerId || reviewerId === "anonymous-reviewer") return false;
  return METHODOLOGIST_ALLOWLIST.includes(reviewerId);
}

const sessions = new Map<string, SessionRecord>();
function makeToken(): string { return randomBytes(24).toString("hex"); }
function nowIso(): string { return new Date().toISOString(); }

export function authMode(): AuthMode { return MODE; }
export function reviewerAllowlist(): string[] { return [...ALLOWLIST]; }

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
    return { ok: false, mode: MODE, error: "reviewer_id may only contain letters, digits, _ . @ -" };
  }
  if (MODE === "required" && !ALLOWLIST.includes(id)) {
    return { ok: false, mode: MODE, error: `reviewer "${id}" is not on the allowlist` };
  }
  const token = makeToken();
  sessions.set(token, { reviewer_id: id, issued_at: nowIso(), last_seen_at: nowIso() });
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

// ── v2-style request helpers (replace v1's Express middleware) ──────

/** Extract a Bearer token from `Authorization` or `?token=` query. */
export function readTokenFromRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const t = url.searchParams.get("token");
  if (t) return t;
  return null;
}

/** Resolve the reviewer for a request. Returns "anonymous-reviewer"
 *  when there's no valid token AND mode === "optional". Returns null
 *  in "required" mode without a token (caller should 401). */
export function readReviewerFromRequest(req: IncomingMessage): string | null {
  const reviewerId = resolveToken(readTokenFromRequest(req));
  if (reviewerId) return reviewerId;
  return MODE === "required" ? null : "anonymous-reviewer";
}

/** Wrap a handler to enforce methodologist privilege. Returns 403 for
 *  non-methodologists, 401 if mode === "required" and no token. */
export type Handler = (body: unknown, req: IncomingMessage) => Promise<unknown>;
export function requireMethodologist(handler: Handler): Handler {
  return async (body, req) => {
    const reviewerId = readReviewerFromRequest(req);
    if (reviewerId === null) {
      const err = new Error("Authorization required. POST /api/auth/login first.") as Error & { status?: number };
      err.status = 401;
      throw err;
    }
    if (!isMethodologist(reviewerId)) {
      const err = new Error("methodologist privilege required") as Error & { status?: number };
      err.status = 403;
      throw err;
    }
    return handler(body, req);
  };
}

/** Build the JSON payload v1's GET /api/auth/whoami returns. */
export function whoami(req: IncomingMessage): {
  mode: AuthMode;
  allowlist: string[] | null;
  reviewer_id: string | null;
  authenticated: boolean;
  is_methodologist: boolean;
} {
  const token = readTokenFromRequest(req);
  const id = resolveToken(token);
  return {
    mode: MODE,
    allowlist: MODE === "required" ? reviewerAllowlist() : null,
    reviewer_id: id,
    authenticated: id !== null,
    is_methodologist: isMethodologist(id),
  };
}

// Test-only export (kept so v2 tests can mirror v1's pattern).
export function _resetSessionsForTest(): void {
  sessions.clear();
}

// Silence unused import warnings if the file is imported but a handler
// isn't wired yet.
void (null as unknown as ServerResponse);
