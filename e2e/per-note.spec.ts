// Per-note labeling UI smoke test.
//
// Guards the per-note feature's two visible surfaces:
//   1. The new-session dialog offers a "Label each note individually" toggle
//      for tasks that opt in (supports_per_note). ACTS is the per-note task.
//   2. (Implicitly) the toggle is gated on the task — a non-per-note task
//      (cancer-diagnosis) does NOT show it.
//
// This test only opens the dialog and asserts the toggle's presence; it
// creates no session, so no cleanup is needed. Modeled on sessions.spec.ts.

import { test, expect } from "@playwright/test";
import { loginAsYuhang, gotoWorkspace } from "./_helpers";

// ACTS is the phenotype task that opts into per-note labeling
// (chart-review-acts/meta.yaml: supports_per_note: true). The task_id the
// loader exposes is the skill dir name minus the "chart-review-" prefix.
const ACTS_TASK_ID = "acts";
// cancer-diagnosis is notes-per-patient (no per_note opt-in) — the toggle
// must NOT appear for it, proving the gate is task-scoped.
const PHENOTYPE_TASK_ID = "cancer-diagnosis";

test.describe("per-note labeling", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsYuhang(page);
  });

  test("per-note toggle shows in the new-session dialog for ACTS", async ({ page }) => {
    await gotoWorkspace(page, ACTS_TASK_ID, "try");
    await page.getByRole("button", { name: /Start new session/i }).first().click();
    // Dialog opened.
    await expect(page.getByText(/Start a new session/i)).toBeVisible();
    // The opt-in toggle is present for this task.
    await expect(page.getByText(/Label each note individually/i)).toBeVisible();
  });

  test("per-note toggle is hidden for a non-per-note task (cancer-diagnosis)", async ({ page }) => {
    await gotoWorkspace(page, PHENOTYPE_TASK_ID, "try");
    await page.getByRole("button", { name: /Start new session/i }).first().click();
    await expect(page.getByText(/Start a new session/i)).toBeVisible();
    // No per-note opt-in for a task that doesn't support it.
    await expect(page.getByText(/Label each note individually/i)).toHaveCount(0);
  });
});
