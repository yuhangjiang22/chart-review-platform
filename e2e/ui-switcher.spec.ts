import { test, expect } from "@playwright/test";
import { loginAsYuhang, startSession, setActiveSession, gotoWorkspace, snapshotActiveSessionIds, archiveSessionsNotIn } from "./_helpers";
const TASK = "cancer-diagnosis"; const SERVER = "http://localhost:3002";
test.describe("rubric switcher UI", () => {
  let token: string; let pre: Set<string>;
  test.beforeEach(async ({ page }) => { token = await loginAsYuhang(page); pre = await snapshotActiveSessionIds(page, token, TASK); });
  test.afterEach(async ({ page }) => { if (token) await archiveSessionsNotIn(page, token, TASK, pre); });

  test("version history renders in the Refine workspace timeline and switches", async ({ page }) => {
    const a = await startSession(page, token, TASK, "ui-switcher", ["patient_easy_neg_02"]);
    // Edit dirties the draft; Save-as-version snapshots s2 (working-draft model).
    await page.request.put(`${SERVER}/api/tasks/${TASK}/criteria/cancer_type?session_id=${encodeURIComponent(a)}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { extraction_guidance: "UI test edit" },
    });
    await page.request.post(`${SERVER}/api/rubric/${TASK}/sessions/${encodeURIComponent(a)}/versions`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { note: "ui checkpoint" },
    });
    await setActiveSession(page, TASK, a);
    await gotoWorkspace(page, TASK, "refine");

    // Version history renders in the refinement workspace with s2 active. Scope to
    // the version spans via [data-active] so we don't collide with the active-version
    // label the DraftStatusBar also renders.
    await expect(page.getByText(/Version history/i)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('span[data-active="true"]')).toHaveText("s2");

    // Switch to s1.
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /switch to s1/i }).click();
    await expect(page.locator('span[data-active="true"]')).toHaveText("s1");
  });
});
