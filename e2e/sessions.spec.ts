// Session workflow smoke tests.
//
// Each test encodes one invariant we've established the hard way (via a
// bug the user spotted in a screenshot). If the invariant breaks, the
// test fails — saving the user from spotting it manually.
//
// The bugs these tests guard against (with commit refs):
//   - "running…" sticking after run errored                          → b14e9c5
//   - "no session, no run" leak into VALIDATE                        → 15346dc
//   - cross-session iter leak (session_002 showing iter_010)         → f85ef7b
//   - NewSessionDialog patient list circular-dep ("no patients")     → 54bae6c
//   - "Agents" vs "Reviewers" label mismatch (sidebar vs main)       → 392979b
//   - Cohort showing 23 workspace patients instead of session's 1    → 7095b3d

import { test, expect } from "@playwright/test";
import {
  loginAsYuhang, gotoWorkspace, startSession, archiveAllSessions,
  setActiveSession,
} from "./_helpers";

// Light platform: one phenotype task only.
const TASK_ID = "cancer-diagnosis";
const COHORT_PATIENT = "patient_easy_nsclc_01";

test.describe("session workflow", () => {
  test.beforeEach(async ({ page }) => {
    const token = await loginAsYuhang(page);
    // Stash the token where each test can grab it without re-logging in.
    (page as unknown as { _token: string })._token = token;
  });

  test.afterEach(async ({ page }) => {
    const token = (page as unknown as { _token: string })._token;
    if (token) await archiveAllSessions(page, token, TASK_ID);
  });

  test("no active session: TRY phase shows the gate, not a run card", async ({ page }) => {
    await setActiveSession(page, TASK_ID, null);
    await gotoWorkspace(page, TASK_ID, "try");
    // Workspace-level no-session gate copy (fires for every phase
    // when activeSessionId is null).
    await expect(
      page.getByText(/Pick or start a session to see this phase/i),
    ).toBeVisible();
    // Sanity check: the "Start iter" button (session-locked branch) should NOT render.
    await expect(page.getByRole("button", { name: /Start iter/i })).toHaveCount(0);
  });

  test("no active session: VALIDATE phase also shows the gate (not a stale run card)", async ({ page }) => {
    await setActiveSession(page, TASK_ID, null);
    await gotoWorkspace(page, TASK_ID, "validate");
    // Workspace-level gate fires here, not the in-pane validation form.
    await expect(
      page.getByText(/Pick or start a session to see this phase/i),
    ).toBeVisible();
    // The previous bug rendered patient chips even with no session. Assert
    // no patient chip for the corpus patient is visible.
    await expect(page.getByText(COHORT_PATIENT)).toHaveCount(0);
  });

  test("new-session dialog: cohort picker loads patients even with no active session", async ({ page }) => {
    await setActiveSession(page, TASK_ID, null);
    await gotoWorkspace(page, TASK_ID, "try");
    await page.getByRole("button", { name: /Start new session/i }).first().click();
    await expect(page.getByText(/Start a new session/i)).toBeVisible();
    // Was the "0/0 selected · No patients available" bug. Assert the
    // counter shows at least 1 candidate.
    const cohortLabel = page.getByText(/Cohort \(\d+\/\d+ selected\)/i);
    await expect(cohortLabel).toBeVisible();
    const text = await cohortLabel.textContent();
    const m = text?.match(/Cohort \((\d+)\/(\d+) selected\)/);
    expect(m, "cohort counter should parse").toBeTruthy();
    expect(parseInt(m![2]!, 10), "available patient count should be > 0").toBeGreaterThan(0);
  });

  test("active session: TRY shows the session's LOCKED cohort, not the whole corpus", async ({ page }) => {
    const token = (page as unknown as { _token: string })._token;
    const sid = await startSession(page, token, TASK_ID, "smoke session A", [COHORT_PATIENT]);
    await setActiveSession(page, TASK_ID, sid);
    await gotoWorkspace(page, TASK_ID, "try");
    // The cohort readout in PhaseTry should show EXACTLY 1 patient.
    await expect(page.getByText(/Cohort \(1 patient\)/i)).toBeVisible();
    // The patient id legitimately appears in both the cohort readout and the
    // sidebar cohort list — scope to the first match (not a duplicate-render bug).
    await expect(page.getByText(COHORT_PATIENT).first()).toBeVisible();
  });

  test("phenotype task: sidebar uses 'Agents' label, matching PhaseTry", async ({ page }) => {
    const token = (page as unknown as { _token: string })._token;
    const sid = await startSession(page, token, TASK_ID, "smoke session B", [COHORT_PATIENT]);
    await setActiveSession(page, TASK_ID, sid);
    await gotoWorkspace(page, TASK_ID, "try");
    // Phenotype → "Agents" in BOTH the main pane and the sidebar. No
    // mismatch like the earlier bug where main said REVIEWERS but
    // sidebar said AGENTS for the same task.
    const agentsLabels = await page.getByText(/Agents \(/).count();
    expect(agentsLabels, "expected ≥1 'Agents' label").toBeGreaterThan(0);
    // And the "Reviewers (" label should NOT appear for phenotype tasks.
    await expect(page.getByText(/^Reviewers \(/)).toHaveCount(0);
  });

  test("cross-session isolation: switching to a session with no iters doesn't show another session's iter", async ({ page }) => {
    const token = (page as unknown as { _token: string })._token;
    // Two sessions, neither has any iters yet.
    const sidA = await startSession(page, token, TASK_ID, "iso A", [COHORT_PATIENT]);
    const sidB = await startSession(page, token, TASK_ID, "iso B", [COHORT_PATIENT]);
    // Switch to B, which has zero iters of its own.
    await setActiveSession(page, TASK_ID, sidB);
    await gotoWorkspace(page, TASK_ID, "validate");
    // Session B has no iters → VALIDATE should render the empty
    // state, NOT a patient validation card. We scope the assertion to
    // <main> so the sidebar's cohort listing (which legitimately
    // lists the patient) doesn't false-positive.
    await expect(
      page.locator("main").getByText(/No active iteration to validate/i),
    ).toBeVisible();
    expect(sidA).not.toEqual(sidB); // sanity check
  });

  test("agent run: TRY → VALIDATE works end-to-end (needs Azure)", async ({ page }) => {
    test.skip(!process.env.AZURE_OPENAI_API_KEY, "needs Azure — set AZURE_OPENAI_API_KEY to run");
    const token = (page as unknown as { _token: string })._token;
    const sid = await startSession(page, token, TASK_ID, "e2e run", [COHORT_PATIENT]);
    await setActiveSession(page, TASK_ID, sid);
    await gotoWorkspace(page, TASK_ID, "try");
    // Start the run and wait for it to reach ready_to_validate.
    await page.getByRole("button", { name: /Start iter/i }).click();
    await expect(page.getByText(/ready to validate/i)).toBeVisible({ timeout: 120_000 });
    // Advance to VALIDATE — patient chip should appear.
    await gotoWorkspace(page, TASK_ID, "validate");
    await expect(page.getByText(COHORT_PATIENT)).toBeVisible();
  });
});
