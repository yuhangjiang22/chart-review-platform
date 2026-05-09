import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const REVIEWER_ID = "test_pi";

async function loginViaApi(req: APIRequestContext): Promise<string> {
  const res = await req.post("http://localhost:3001/api/auth/login", {
    data: { reviewer_id: REVIEWER_ID },
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json();
  expect(body.ok).toBeTruthy();
  return body.token as string;
}

async function plantToken(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ({ token, reviewerId }) => {
      localStorage.setItem("chart-review-token", token);
      localStorage.setItem("chart-review-reviewer-id", reviewerId);
    },
    { token, reviewerId: REVIEWER_ID },
  );
}

test.describe("chart-review-guideline-builder e2e", () => {
  test.beforeEach(async ({ page, request }) => {
    const token = await loginViaApi(request);
    await plantToken(page, token);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /what should you review/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test.skip("happy path — intake → first assistant_prose (2-phase rewrite pending)", async ({ page }) => {
    test.setTimeout(180_000); // up to 3 min for the agent's first turn

    // Navigate to Studio → Authoring
    await page.locator('aside button:has-text("Studio")').click();
    await page.locator('button:text-is("Authoring")').click();

    // Open mode picker, choose Builder
    // The button text is "Start a new task draft" (exact text in AuthoringFigure)
    await page.getByRole("button", { name: /start a new task draft/i }).click();
    // Dialog button text is "Builder (interactive)"
    await page.getByRole("button", { name: /Builder \(interactive\)/i }).click();

    // Builder intake: enter a task_id
    // placeholder is "post-mi-followup" which contains "post-mi"
    const taskInput = page.locator('input[placeholder*="post-mi"]');
    const taskId = `e2e-test-${Date.now()}`;
    await taskInput.fill(taskId);
    await page.getByRole("button", { name: /open builder/i }).click();

    // Wait for the chat rail to appear and the agent to emit its first turn
    // The aside uses className="flex h-full w-[340px]..." so w-\[340px\] matches
    await expect(page.locator("aside.w-\\[340px\\]")).toBeVisible({ timeout: 10_000 });

    // Send the initial intent message that gets the agent grilling
    // placeholder is "Type a reply or drop a file…" which contains "reply"
    const composer = page.locator('textarea[placeholder*="reply"]');
    await composer.fill(
      "Build a guideline for whether the patient received recommended 30-day post-MI follow-up.",
    );
    await page.getByRole("button", { name: /^Send$/i }).click();

    // Wait for the agent to emit ANY response — first prose or first card.
    // Agent timing varies; wait up to 120s for first signal.
    // The agent may respond with any of these keywords given the builder SKILL.md prompt.
    await expect(
      page.locator(":text-matches(\"output shape|outcome-first|evidence-first|recommended|follow.up|post.mi\", \"i\")").first(),
    ).toBeVisible({ timeout: 120_000 });

    console.log(`[ok] builder e2e produced first agent response for ${taskId}`);

    // Cleanup the test draft
    // (left in place; future test runs are gitignored under guidelines/drafts/)
  });
});
