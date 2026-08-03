// Service-health pill smoke test (Phase 1 of the UI-first work).
//
// Guards the always-visible service-health indicator (ServiceHealthBanner):
//   1. It renders on the shell and shows one of its two states.
//   2. Clicking it expands the per-service detail (API / model / NER proxy /
//      workbench / sidecar).
// It doesn't assert a specific up/down state (that depends on which services
// happen to be running), only that the indicator + its detail render.
import { test, expect } from "@playwright/test";
import { loginAsYuhang } from "./_helpers";

test.describe("service-health pill", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsYuhang(page);
    await page.goto("/#/tasks");
  });

  test("renders the health pill and expands per-service detail", async ({ page }) => {
    const pill = page.getByRole("button", { name: "Service health" });
    await expect(pill).toBeVisible();
    // pill text is one of the two calm/warn states
    await expect(pill).toHaveText(/services (ok|need attention)/i);

    // expand → per-service rows appear
    await pill.click();
    await expect(page.getByText(/API server/i)).toBeVisible();
    await expect(page.getByText(/NER proxy :18080/i)).toBeVisible();
    await expect(page.getByText(/Model —/i)).toBeVisible();
  });
});
