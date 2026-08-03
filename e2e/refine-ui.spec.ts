// Refine-workspace + top-bar UI invariants — encodes the display bugs caught the
// hard way in screenshots this iteration so they fail loudly if they regress:
//   - no horizontal page overflow on any phase tab (pill-bar / dropdown / refine width)
//   - session switcher lives in the top bar; its dropdown opens fully on-screen
//   - all five phase pills render (REFINE not clipped)
//   - Refine tab shows draft bar + current-rubric + suggested-refinements + versions
//   - Performance is metrics-only (no per-field Refine button)
//   - version history appears on a non-Refine tab's sidebar
//   - a session's version ids are unique (no duplicate s3)
import { test, expect } from "@playwright/test";
import { loginAsYuhang, setActiveSession, gotoWorkspace, apiGet } from "./_helpers";

const TASK = "cancer-diagnosis";
const SID = "session_263"; // has versions s1/s2 + a validated run from the e2e pipeline
const PHASES = ["author", "try", "validate", "decide", "refine"] as const;

async function horizontalOverflow(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe("refine-workspace + top-bar UI", () => {
  test("no horizontal page overflow on any phase tab (wide viewport)", async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await loginAsYuhang(page);
    await setActiveSession(page, TASK, SID);
    for (const phase of PHASES) {
      await gotoWorkspace(page, TASK, phase);
      await page.waitForTimeout(900);
      const o = await horizontalOverflow(page);
      expect(o, `phase ${phase} overflows by ${o}px`).toBeLessThanOrEqual(1);
    }
  });

  test("all five phase pills render (REFINE not clipped)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsYuhang(page);
    await setActiveSession(page, TASK, SID);
    await gotoWorkspace(page, TASK, "refine");
    for (const label of ["Author", "Try", "Validate", "Performance", "Refine"]) {
      await expect(page.getByRole("button", { name: new RegExp(`^${label} phase`, "i") })).toBeVisible();
    }
  });

  test("session switcher is in the top bar and its dropdown opens fully on-screen", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAsYuhang(page);
    await setActiveSession(page, TASK, SID);
    await gotoWorkspace(page, TASK, "refine");
    await page.waitForTimeout(800);
    await page.locator('button[aria-haspopup="listbox"]').click();
    await expect(page.getByText(/Start new session/i)).toBeVisible();
    const o = await horizontalOverflow(page);
    expect(o, `dropdown overflows by ${o}px`).toBeLessThanOrEqual(1);
    const box = await page.getByRole("listbox").boundingBox();
    expect(box!.x, "dropdown left edge off-screen").toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, "dropdown right edge past viewport").toBeLessThanOrEqual(1440 + 1);
  });

  test("Refine tab: draft bar + current rubric + suggested refinements + version history", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAsYuhang(page);
    await setActiveSession(page, TASK, SID);
    await gotoWorkspace(page, TASK, "refine");
    await expect(page.getByText(/On version s\d|unsaved change/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Current rubric/i)).toBeVisible();
    await expect(page.getByText(/Suggested refinements/i)).toBeVisible();
    await expect(page.getByText(/Version history/i)).toBeVisible();
  });

  test("Performance is metrics-only — no per-field Refine button", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsYuhang(page);
    await setActiveSession(page, TASK, SID);
    await gotoWorkspace(page, TASK, "decide");
    await expect(page.getByText(/^Performance$/).first()).toBeVisible({ timeout: 10000 });
    // The phase pill's accessible name is "Refine phase …", so an exact "Refine"
    // button only exists if the old per-field affordance came back.
    await expect(page.getByRole("button", { name: /^Refine$/ })).toHaveCount(0);
  });

  test("version history shows on a non-Refine tab's sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsYuhang(page);
    await setActiveSession(page, TASK, SID);
    await gotoWorkspace(page, TASK, "decide");
    await expect(page.getByText(/Version history/i)).toBeVisible({ timeout: 10000 });
  });

  test("session version ids are unique (no duplicate snapshot id)", async ({ page }) => {
    const token = await loginAsYuhang(page);
    const v = (await apiGet(page, `/api/rubric/${TASK}/sessions/${SID}/versions`, token)) as {
      versions: { id: string }[];
    };
    const ids = v.versions.map((x) => x.id);
    expect(new Set(ids).size, `duplicate ids in ${ids.join(",")}`).toBe(ids.length);
  });
});
