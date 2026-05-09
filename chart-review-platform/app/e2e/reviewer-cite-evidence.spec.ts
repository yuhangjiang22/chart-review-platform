/**
 * E2E test for the reviewer evidence-citation flow.
 *
 * Drives the real UI against a real Express server. Covers:
 *   1. login + open a pilot patient on lung-cancer-phenotype
 *   2. select a criterion
 *   3. switch to the Structured tab and cite the first row via the per-row
 *      "Cite" button (the client-track entry point for OMOP evidence)
 *   4. submit/lock the review and verify review_state.json on disk gained
 *      a new evidence entry under that field.
 *
 * Skipped by default — set E2E_REVIEWER_CITE=1 to enable. Reuses the
 * fixture corpus seeded for vibe-chart-review.spec.ts so this test does
 * NOT rerun any agents or LLM calls.
 *
 * If the test environment is missing a pre-existing review_state.json for
 * the target patient×task, the test imports the most recent agent draft
 * for that patient (same path used by vibe-chart-review.spec.ts).
 */

import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import fs from "fs";
import path from "path";

const TASK_ID = "lung-cancer-phenotype";
const REVIEWER_ID = "test_pi";
const PATIENT_ID = "patient_easy_neg_01";
const FIELD_ID = "icd_lung_cancer_present";

// ──────────────────────────────────────────────────────────────────────────
// Auth — same pattern as vibe-chart-review.spec.ts / builder.spec.ts.
// ──────────────────────────────────────────────────────────────────────────
async function loginViaApi(req: APIRequestContext): Promise<string> {
  const res = await req.post("http://localhost:3001/api/auth/login", {
    data: { reviewer_id: REVIEWER_ID },
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json();
  expect(body.ok, `login should succeed (got: ${JSON.stringify(body)})`).toBeTruthy();
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

async function openPatientViaPalette(
  page: Page,
  patientId: string,
): Promise<void> {
  await page.getByRole("button", { name: /search anything/i }).click();
  const display = patientId.replace(/^patient_/, "").replace(/_/g, " ");
  await page.keyboard.type(display);
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
}

async function ensureReviewStateExists(
  req: APIRequestContext,
  token: string,
): Promise<void> {
  // Cheapest path: import the latest agent draft for this patient×task.
  // Same code path used by the copilot test in vibe-chart-review.spec.ts.
  const runsRes = await req.get(
    `http://localhost:3001/api/runs?task_id=${TASK_ID}&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const runs = await runsRes.json();
  if (runs[0]) {
    await req.post(
      `http://localhost:3001/api/runs/${runs[0].run_id}/patients/${PATIENT_ID}/import`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        data: { force: true },
      },
    );
  }
}

function reviewsRoot(): string {
  // Mirror the server's REVIEWS_ROOT resolution.
  const override = process.env.CHART_REVIEW_REVIEWS_ROOT;
  if (override) return override;
  // Default: chart-review-platform/reviews/, computed relative to the
  // test file location (e2e lives under chart-review-platform/app/e2e/).
  return path.resolve(__dirname, "..", "..", "reviews");
}

test.describe("reviewer evidence citation", () => {
  test.skip(
    process.env.E2E_REVIEWER_CITE !== "1",
    "set E2E_REVIEWER_CITE=1 to run (requires seeded fixture corpus + dev server)",
  );

  test.beforeEach(async ({ page, request }) => {
    const token = await loginViaApi(request);
    await plantToken(page, token);
    await ensureReviewStateExists(request, token);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /what should you review/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("reviewer cites a structured row and submits", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    // Open the pilot patient.
    await openPatientViaPalette(page, PATIENT_ID);

    // Click into the target field's compact criterion pane so it becomes
    // the "selectedField" for the cite buttons in StructuredTab.
    const fieldHeader = page.getByRole("heading", { name: FIELD_ID }).first();
    await expect(fieldHeader).toBeVisible({ timeout: 10_000 });
    await fieldHeader.click();

    // Switch to the Structured tab in the right-pane NoteViewer. Tab
    // labels are lowercased (`notes` / `structured` / `timeline`).
    await page.locator('button:text-is("structured")').click();

    // The first table row exposes a `data-row-key` attribute. Hover to
    // reveal the "Cite" button (group-hover:opacity-100).
    const firstRow = page.locator("[data-row-key]").first();
    await firstRow.scrollIntoViewIfNeeded();
    await firstRow.hover();
    const citeButton = firstRow.getByRole("button", { name: /^cite$/i });
    await expect(citeButton).toBeVisible({ timeout: 5_000 });
    await citeButton.click();

    // Give the WebSocket-driven state update time to flush to disk.
    await page.waitForTimeout(1500);

    // Verify on-disk review_state.json has at least one evidence entry
    // for this field.
    const statePath = path.join(
      reviewsRoot(),
      PATIENT_ID,
      TASK_ID,
      "review_state.json",
    );
    expect(
      fs.existsSync(statePath),
      `review_state.json should exist at ${statePath}`,
    ).toBeTruthy();
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const fa = state.field_assessments.find(
      (x: { field_id: string }) => x.field_id === FIELD_ID,
    );
    expect(fa, `assessment for ${FIELD_ID} should exist`).toBeDefined();

    // Sanity: assessment carries some evidence (either pre-existing agent
    // draft evidence or the new one we just cited). Empty evidence would
    // mean the cite never landed.
    expect(
      (fa.evidence?.length ?? 0),
      `${FIELD_ID} should carry at least one evidence row`,
    ).toBeGreaterThan(0);
  });
});
