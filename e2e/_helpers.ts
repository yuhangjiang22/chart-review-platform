// Shared helpers for Studio smoke tests.
//
// loginAsYuhang() — POSTs to /api/auth/login, then stuffs the token +
// reviewer_id into localStorage at the keys client/src/auth.ts reads.
// Must be called BEFORE navigating to the workspace, so the first
// fetch carries the Bearer header.
//
// startSession() / archiveSession() — convenience wrappers around the
// session API, called over fetch with the test's token. Used by tests
// to set up state without clicking through the dialog every time.

import { type Page, expect } from "@playwright/test";

const SERVER = "http://localhost:3002";
const TOKEN_KEY = "chart-review-token";
const REVIEWER_KEY = "chart-review-reviewer-id";

export async function loginAsYuhang(page: Page): Promise<string> {
  // 1. Login against the server directly (no UI yet — we haven't loaded a page).
  const r = await page.request.post(`${SERVER}/api/auth/login`, {
    data: { reviewer_id: "yuhang" },
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok()) throw new Error(`login failed: ${r.status()} ${await r.text()}`);
  const body = await r.json() as { token: string };
  const token = body.token;

  // 2. Inject the token into localStorage BEFORE any page load so the
  //    React app sees it on its first render (whoami() returns
  //    authenticated=true and we skip the sign-in screen). Using
  //    addInitScript means the LS write runs before any JS on the
  //    page, on every navigation in this page's lifetime.
  await page.addInitScript(
    ({ tokenKey, reviewerKey, tokenVal }) => {
      localStorage.setItem(tokenKey, tokenVal);
      localStorage.setItem(reviewerKey, "yuhang");
    },
    { tokenKey: TOKEN_KEY, reviewerKey: REVIEWER_KEY, tokenVal: token },
  );

  return token;
}

export async function apiGet(page: Page, path: string, token: string) {
  const r = await page.request.get(`${SERVER}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok()) throw new Error(`GET ${path} → ${r.status()}: ${await r.text()}`);
  return r.json();
}

export async function apiPost(page: Page, path: string, body: unknown, token: string) {
  const r = await page.request.post(`${SERVER}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    data: body,
  });
  if (!r.ok()) throw new Error(`POST ${path} → ${r.status()}: ${await r.text()}`);
  return r.json();
}

/** Create a fresh session via the API. Used by tests that need an
 *  active session but don't want to drive the dialog. Includes a default
 *  agent_spec so the session is runnable + matches the server's
 *  ≥1-agent requirement (a specless session is unrunnable and drifts). */
export async function startSession(
  page: Page, token: string, taskId: string, name: string, patientIds: string[],
  agentSpecs: Array<Record<string, unknown>> = [
    { id: "agent_1", model: "claude-sonnet", role_preset: "default", role_version: "v1" },
  ],
): Promise<string> {
  const body = await apiPost(page, `/api/sessions/${taskId}`, {
    name, patient_ids: patientIds, agent_specs: agentSpecs,
  }, token) as { session: { session_id: string } };
  return body.session.session_id;
}

export async function archiveSession(
  page: Page, token: string, taskId: string, sessionId: string,
): Promise<void> {
  await apiPost(page, `/api/sessions/${taskId}/${sessionId}/archive`, {}, token);
}

/** Set the active session in localStorage so the workspace picks it up
 *  on next navigation. Mirrors how SessionSwitcher persists the choice.
 *  Uses addInitScript so the value is present BEFORE the React app
 *  renders — matches the login helper's pattern. */
export async function setActiveSession(
  page: Page, taskId: string, sessionId: string | null,
): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    },
    { key: `chart-review:active-session:${taskId}`, value: sessionId },
  );
}

/** Navigate to the workspace for a given task. The Studio hash routing
 *  uses #/studio/<task_id>/<phase>. */
export async function gotoWorkspace(page: Page, taskId: string, phase = "try") {
  await page.goto(`/#/studio/${taskId}/${phase}`);
  await expect(page.locator("body")).toBeVisible();
}

/** Cleanup helper: archive ALL sessions for a task. Safe to call from
 *  afterAll — uses the API, no UI interactions. */
export async function archiveAllSessions(
  page: Page, token: string, taskId: string,
): Promise<void> {
  const list = await apiGet(page, `/api/sessions/${taskId}`, token) as {
    sessions: Array<{ session: { session_id: string; state: string } }>;
  };
  for (const s of list.sessions) {
    if (s.session.state === "active" && s.session.session_id !== "session_legacy") {
      try { await archiveSession(page, token, taskId, s.session.session_id); }
      catch { /* tolerate */ }
    }
  }
}
