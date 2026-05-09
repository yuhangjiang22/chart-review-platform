import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("dual-agent pilot end-to-end", () => {
  test.skip(process.env.E2E_DUAL_AGENT !== "1", "long-running; set E2E_DUAL_AGENT=1 to run");

  test("starts a pilot with N=2 and renders disagreements", async ({ page }) => {
    await page.goto("/");
    await page.click("text=Studio");
    await page.click("text=lung-cancer-phenotype");
    await page.click("text=Pilots");
    await page.click('button:has-text("Start iteration")');
    await expect(page.locator("text=Agents (N = 2)")).toBeVisible();
    await page.click('button:has-text("Start")');
    await page.waitForSelector("text=ready_to_validate", { timeout: 10 * 60 * 1000 });
    await page.click("text=patient_probable_fhx_01");
    await expect(page.locator("text=Agent 1")).toBeVisible();
    await expect(page.locator("text=Agent 2")).toBeVisible();
    await expect(page.locator("text=disagreed")).toBeVisible();
  });
});
