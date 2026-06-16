import { test, expect } from "@playwright/test";
import { loginAsYuhang, startSession, setActiveSession, gotoWorkspace, snapshotActiveSessionIds, archiveSessionsNotIn } from "./_helpers";
const TASK = "cancer-diagnosis"; const SERVER = "http://localhost:3002";
test.describe("rubric switcher UI", () => {
  let token: string; let pre: Set<string>;
  test.beforeEach(async ({ page }) => { token = await loginAsYuhang(page); pre = await snapshotActiveSessionIds(page, token, TASK); });
  test.afterEach(async ({ page }) => { if (token) await archiveSessionsNotIn(page, token, TASK, pre); });

  test("switcher renders in the sidebar with the version timeline and switches", async ({ page }) => {
    const a = await startSession(page, token, TASK, "ui-switcher", ["patient_easy_neg_02"]);
    // create s2 via a session-scoped edit
    await page.request.put(`${SERVER}/api/tasks/${TASK}/criteria/cancer_type?session_id=${encodeURIComponent(a)}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { extraction_guidance: "UI test edit" },
    });
    await setActiveSession(page, TASK, a);
    await gotoWorkspace(page, TASK, "try");

    // The switcher should render in the sidebar with both versions, s2 active.
    await expect(page.getByText(/Rubric versions/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("s2", { exact: true })).toHaveAttribute("data-active", "true");
    await expect(page.getByText("s1", { exact: true })).toHaveAttribute("data-active", "false");

    // Switch to s1.
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /switch to s1/i }).click();
    await expect(page.getByText("s1", { exact: true })).toHaveAttribute("data-active", "true");
  });
});
