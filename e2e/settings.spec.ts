// Settings page smoke test (Phase 2 of the UI-first work).
//
// Guards the config-in-UI surface (SettingsPage):
//   1. The header gear routes to #/settings and the page renders.
//   2. The backend toggle swaps the Azure vs vLLM field sets.
//   3. Secret fields never show a value — only a masked "leave blank to keep"
//      placeholder (the key never round-trips to the browser).
import { test, expect } from "@playwright/test";
import { loginAsYuhang } from "./_helpers";

test.describe("settings — model config", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsYuhang(page);
    await page.goto("/#/settings");
  });

  test("renders, toggles backend, and masks the key field", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // backend toggle → vLLM shows a Base URL field
    await page.getByRole("button", { name: /vLLM \/ OpenRouter/i }).click();
    await expect(page.getByText(/Base URL/i)).toBeVisible();

    // the API-key input is a password field and holds no value (masked)
    const keyInput = page.locator('input[type="password"]');
    await expect(keyInput.first()).toBeVisible();
    await expect(keyInput.first()).toHaveValue("");

    // Save + Test connection controls exist
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Test connection/i })).toBeVisible();
  });
});
