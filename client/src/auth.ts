/**
 * Reviewer-side auth glue. Tiny wrapper around localStorage + fetch +
 * WS query-token construction, so the rest of the UI doesn't have to
 * think about Authorization headers.
 *
 *   - In `optional` mode (server default): we still issue + carry a
 *     token if the user logs in, but unauthenticated requests are
 *     accepted (server treats them as "anonymous-reviewer").
 *   - In `required` mode: every request needs a Bearer token; if the
 *     server returns 401 we drop the token and bounce back to the
 *     login form.
 */

const TOKEN_KEY = "chart-review-token";
const REVIEWER_KEY = "chart-review-reviewer-id";

export interface AuthSnapshot {
  token: string | null;
  reviewer_id: string | null;
}

export function readAuth(): AuthSnapshot {
  return {
    token: localStorage.getItem(TOKEN_KEY),
    reviewer_id: localStorage.getItem(REVIEWER_KEY),
  };
}

export function writeAuth(token: string, reviewer_id: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(REVIEWER_KEY, reviewer_id);
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REVIEWER_KEY);
}

/** fetch wrapper that injects Authorization: Bearer <token> if present. */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const { token } = readAuth();
  const headers = new Headers(init.headers ?? {});
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

/** Build a /ws URL with ?token=… for in-browser WS connections. */
export function buildWsUrl(): string {
  const { token } = readAuth();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/ws`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export interface WhoamiResponse {
  mode: "optional" | "required";
  allowlist: string[] | null;
  reviewer_id: string | null;
  authenticated: boolean;
  is_methodologist: boolean;
}

export async function whoami(): Promise<WhoamiResponse> {
  const r = await authFetch("/api/auth/whoami");
  return r.json();
}

export interface LoginResponse {
  ok: boolean;
  token?: string;
  reviewer_id?: string;
  mode: "optional" | "required";
  error?: string;
}

export async function login(reviewerId: string): Promise<LoginResponse> {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewer_id: reviewerId }),
  });
  const body: LoginResponse = await r.json();
  if (body.ok && body.token && body.reviewer_id) {
    writeAuth(body.token, body.reviewer_id);
  }
  return body;
}

export async function logout(): Promise<void> {
  try {
    await authFetch("/api/auth/logout", { method: "POST" });
  } finally {
    clearAuth();
  }
}
