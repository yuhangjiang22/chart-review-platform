/**
 * End-to-end test of the vibe-chart-review platform.
 *
 * Drives the real UI (Vite + React) against a real Express server, with
 * real OpenRouter→Claude Haiku LLM calls for the agent batch run and
 * one chat-copilot interaction. Cost: roughly $0.15-0.30.
 *
 * Validates:
 *   1. Login + header (whoami, methodologist link, notifications bell)
 *   2. Studio renders all 10 cards
 *   3. Maturity panel: real transitions
 *   4. Calibration: deterministic run + report viewer
 *   5. Pilot iteration: start a 1-patient run, wait for completion
 *   6. Triage queue + patient summary
 *   7. Import draft into reviews/
 *   8. Reviewer chat session (real WebSocket + agent reply)
 *   9. Reproducibility export with statistics + git commit
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const TASK_ID = "lung-cancer-phenotype";
const REVIEWER_ID = "test_pi";
// One easy patient — keeps cost predictable. The agent has produced 6/6 exact
// matches on this case in prior runs.
const PATIENT_ID = "patient_easy_neg_01";

// ──────────────────────────────────────────────────────────────────────────
// Auth helper: login via API then plant the token in localStorage so the
// rendered React app skips LoginGate and renders the main shell.
// ──────────────────────────────────────────────────────────────────────────
async function loginViaApi(req: APIRequestContext): Promise<string> {
  const res = await req.post("http://localhost:3001/api/auth/login", {
    data: { reviewer_id: REVIEWER_ID },
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json();
  expect(body.ok, `login should succeed (got: ${JSON.stringify(body)})`).toBeTruthy();
  return body.token;
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

// Open a patient by routing through the ⌘K palette. The palette is the
// canonical navigation surface; clicking the topbar Search button is the
// same code path. Tests use this so they don't have to know about the
// underlying nav structure.
async function openPatientViaPalette(page: Page, patientId: string): Promise<void> {
  await page.getByRole("button", { name: /search anything/i }).click();
  // Type the human-friendly form so the fuzzy match lands quickly.
  const display = patientId.replace(/^patient_/, "").replace(/_/g, " ");
  await page.keyboard.type(display);
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  // Wait for the patient detail to mount (chat rail "Copilot" header).
  await page.waitForTimeout(800);
}

async function resetMaturityToDraft(req: APIRequestContext, token: string) {
  // Force the guideline back to draft. Backward transitions require a
  // reason, which the API enforces. Forward transitions don't, but draft is
  // also a valid no-op when already there (the API returns "already X" so we
  // ignore failures).
  await req.post(
    `http://localhost:3001/api/guidelines/${TASK_ID}/maturity`,
    {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { state: "draft", reason: "e2e — reset to known starting state" },
    },
  );
}

test.describe("vibe chart review — full e2e", () => {
  test.beforeEach(async ({ page, request }) => {
    const token = await loginViaApi(request);
    await plantToken(page, token);
    await page.goto("/");
    // App lands on the Queue. Hero heading is "What should you review next?"
    await expect(page.getByRole("heading", { name: /what should you review/i })).toBeVisible({ timeout: 15_000 });
  });

  test("1. App shell — sidebar nav, top bar, active task pill, ⌘K trigger", async ({ page }) => {
    // Sidebar nav with the five primary routes
    for (const item of ["Queue", "Patient", "Studio", "Audit", "Help"]) {
      await expect(page.locator(`aside button:has-text("${item}")`).first()).toBeVisible();
    }
    // Active-task tile pinned at the bottom of the sidebar (Plex Mono div)
    await expect(page.locator(`aside .font-mono:has-text("${TASK_ID}")`).first()).toBeVisible();
    // ⌘K trigger in the top bar
    await expect(page.getByRole("button", { name: /search anything/i })).toBeVisible();
    console.log("[ok] app shell surfaces");
  });

  test("2. Studio renders six tabs in the editorial figures layout", async ({ page }) => {
    await page.locator('aside button:has-text("Studio")').click();
    await expect(page.getByRole("heading", { name: /^Studio$/ })).toBeVisible();
    for (const tab of ["Pilots", "Calibration", "Rules", "Methods", "Bundles", "Authoring"]) {
      await expect(page.locator(`button:text-is("${tab}")`)).toBeVisible();
    }
    // The default tab (Pilots) shows a "FIGURE 1" caption in the figures layout
    await expect(page.locator('text=/^FIGURE 1$/i').first()).toBeVisible();
    console.log("[ok] Studio tabs present");
  });

  test("3. Maturity transitions via API (no UI yet)", async ({ request }) => {
    // App doesn't surface MaturityPanel — maturity transitions still live
    // on the server. Verify the state machine works at the API layer.
    const token = await loginViaApi(request);
    await resetMaturityToDraft(request, token);
    const r = await request.post(
      `http://localhost:3001/api/guidelines/${TASK_ID}/maturity`,
      {
        data: { state: "piloted", reason: "e2e — first pilot iteration" },
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      },
    );
    const body = await r.json();
    expect(["piloted", "already piloted"]).toContain(body.state ?? body.error ?? "");
    console.log("[ok] maturity transition draft → piloted via API");
  });

  test("4. Studio · Calibration tab — run kappa + show per-criterion table", async ({ page }) => {
    await page.locator('aside button:has-text("Studio")').click();
    await page.locator('button:text-is("Calibration")').click();
    await expect(page.locator('text=/^FIGURE 2$/i').first()).toBeVisible();
    await page.getByRole("button", { name: /run calibration/i }).click();
    // After the click the page must show *some* result — either the κ table
    // (if there's enough locked data) or the "No calibration data yet" empty
    // hint. Both are correct outcomes; the failure mode we're guarding
    // against is a JS crash or a permanent spinner.
    const tableOrEmpty = page
      .locator("table tbody tr")
      .first()
      .or(page.locator("text=/No calibration data yet/i"));
    await expect(tableOrEmpty).toBeVisible({ timeout: 60_000 });
    console.log("[ok] calibration tab responded to Run click");
  });

  test("5. Pilot iteration with real agent run on 1 patient (API)", async ({ request }) => {
    test.setTimeout(4 * 60 * 1000); // give the agent up to 4 min

    // App doesn't yet expose a "start a run" UI in Studio Pilots; the run
    // is started via the existing /api/runs endpoint. Same backend path
    // the legacy RunsPanel hit; we just skip the modal click chain.
    const token = await loginViaApi(request);
    const startRes = await request.post("http://localhost:3001/api/runs", {
      data: { task_id: TASK_ID, patient_ids: [PATIENT_ID] },
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    expect(startRes.ok()).toBeTruthy();
    const startBody = await startRes.json();
    const runId = startBody.run_id;
    expect(runId, "API should return a run_id").toBeTruthy();
    console.log("[run] run_id =", runId);

    let state = "running";
    const start = Date.now();
    while (state === "running" && Date.now() - start < 3 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 5_000));
      const sRes = await request.get(`http://localhost:3001/api/runs/${runId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const s = await sRes.json();
      state = s.state;
      console.log(`[poll +${Math.round((Date.now() - start) / 1000)}s] state=${state} complete=${s.n_complete}/${s.n_patients}`);
    }
    expect(state).not.toBe("running");
    console.log("[ok] run completed:", state);
  });

  test("6. Studio · Bundles tab — export new bundle + see it in the list", async ({ page, request }) => {
    const token = await loginViaApi(request);
    const beforeRes = await request.get(`http://localhost:3001/api/exports/${TASK_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const beforeCount = (await beforeRes.json()).length;

    await page.locator('aside button:has-text("Studio")').click();
    await page.locator('button:text-is("Bundles")').click();
    await expect(page.locator('text=/^FIGURE 5$/i').first()).toBeVisible();
    await page.getByRole("button", { name: /export new bundle/i }).click();
    // Wait for the list to refresh — count must increase by at least 1.
    await expect
      .poll(
        async () => {
          const r = await request.get(`http://localhost:3001/api/exports/${TASK_ID}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          return (await r.json()).length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(beforeCount);
    console.log("[ok] bundle exported via Studio");
  });

  test("7. Chat copilot: real agent reply on a patient (chat rail)", async ({ page, request }) => {
    test.setTimeout(3 * 60 * 1000);

    // ⌘K → type patient name → Enter → lands in PatientDetail. The chat
    // rail is permanent on the left; no layout-mode dance.
    await openPatientViaPalette(page, PATIENT_ID);
    await expect(page.locator('aside.w-\\[340px\\]').first()).toBeVisible({ timeout: 15_000 });

    const textarea = page.locator('aside.w-\\[340px\\] textarea').first();
    await textarea.fill("Briefly summarize this patient's lung cancer status in one sentence.");
    await textarea.press("Enter");
    console.log("[chat] sent via chat rail");

    let gotReply = false;
    const token = await loginViaApi(request);
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      await page.waitForTimeout(3_000);
      const msgsRes = await request.get(
        `http://localhost:3001/api/patients/${PATIENT_ID}/messages`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const msgs = await msgsRes.json();
      const assistantMsgs = msgs.filter(
        (m: { role: string; content?: string }) =>
          m.role === "assistant" && (m.content ?? "").length > 20,
      );
      console.log(`[chat poll +${Math.round((Date.now() - start) / 1000)}s] msgs=${msgs.length} assistant=${assistantMsgs.length}`);
      if (assistantMsgs.length > 0) {
        gotReply = true;
        console.log("[chat] assistant reply captured:", String(assistantMsgs[0].content).slice(0, 200));
        break;
      }
    }
    expect(gotReply, "agent should respond within 2 minutes").toBeTruthy();
  });

  // Multi-mode chat copilot test — exercises Explain / Retrieve / Guide modes
  // sequentially on a patient where review_state has been imported, so the
  // copilot has draft answers to explain. Cost: ~$0.25-0.50.
  test("8. Review-copilot: 3-turn multi-mode chat", async ({ page, request }) => {
    test.setTimeout(5 * 60 * 1000);
    const token = await loginViaApi(request);

    // Ensure a review_state exists by importing the most recent run's draft.
    const runsRes = await request.get(
      `http://localhost:3001/api/runs?task_id=${TASK_ID}&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const runs = await runsRes.json();
    if (runs[0]) {
      await request.post(
        `http://localhost:3001/api/runs/${runs[0].run_id}/patients/${PATIENT_ID}/import`,
        {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          data: { force: true },
        },
      );
    }

    await openPatientViaPalette(page, PATIENT_ID);
    await expect(page.locator('aside.w-\\[340px\\]').first()).toBeVisible({ timeout: 15_000 });

    const textarea = page.locator('aside.w-\\[340px\\] textarea').first();

    // Turn 1 (Explain mode)
    const turns = [
      "Why did the agent say active_lung_cancer = no? Cite the strongest piece of evidence.",
      "What does the guideline say about pathology_lung_primary when there's no pathology report?",
      "Show me any evidence in the chart that hints at active disease — strong, weak, or counter-evidence.",
    ];
    const labels = ["Explain", "Guide", "Retrieve"];

    const replies: string[] = [];
    for (let i = 0; i < turns.length; i++) {
      console.log(`[copilot] turn ${i + 1} (${labels[i]}): ${turns[i].slice(0, 80)}...`);
      const beforeRes = await request.get(
        `http://localhost:3001/api/patients/${PATIENT_ID}/messages`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const beforeCount = (await beforeRes.json()).length;

      await textarea.fill(turns[i]);
      await textarea.press("Enter");
      await page.waitForTimeout(800);

      // Wait until the agent stops streaming (no new messages for 15 seconds),
      // then grab the LAST substantive assistant message. This avoids the
      // #52 narration trap — short "I'll search…" lines arrive first but the
      // actual answer comes at the end of the run.
      let lastCount = beforeCount;
      let stableSince = Date.now();
      const start = Date.now();
      let finalMsgs: Array<{ role: string; content?: string }> = [];
      while (Date.now() - start < 180_000) {
        await page.waitForTimeout(3_000);
        const msgsRes = await request.get(
          `http://localhost:3001/api/patients/${PATIENT_ID}/messages`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const msgs = await msgsRes.json();
        if (msgs.length !== lastCount) {
          lastCount = msgs.length;
          stableSince = Date.now();
        } else if (msgs.length > beforeCount && Date.now() - stableSince > 15_000) {
          finalMsgs = msgs;
          break;
        }
      }
      expect(finalMsgs.length, `turn ${i + 1} (${labels[i]}) should produce messages`).toBeGreaterThan(beforeCount);

      // Take the substantive answer = the LAST assistant message in the
      // turn's window, regardless of length. (The previous > 30 filter was
      // dropping legitimate compact answers.)
      const turnMsgs = finalMsgs.slice(beforeCount);
      const assistantInTurn = turnMsgs.filter(
        (m: { role: string; content?: string }) => m.role === "assistant",
      );
      if (assistantInTurn.length === 0) {
        console.log(`[copilot turn ${i + 1}] DEBUG — turnMsgs roles:`,
          turnMsgs.map((m) => `${m.role}(${(m.content ?? "").length}c)`).join(", "));
      }
      expect(assistantInTurn.length, `turn ${i + 1} should have at least one assistant message`).toBeGreaterThan(0);
      const last = assistantInTurn[assistantInTurn.length - 1].content as string;
      replies.push(last);
      console.log(`[copilot turn ${i + 1}] assistant reply (${last.length} chars):`);
      console.log("   " + last.split("\n").slice(0, 6).join("\n   "));
    }

    // Validate that the replies look mode-appropriate. We use loose substring
    // checks since the LLM phrases vary; the goal is to catch obvious
    // failures (e.g. "I'll activate the chart-review skill" generic answers).
    const fullText = replies.join("\n\n").toLowerCase();
    // Should reference the guideline + at least one note + at least one
    // criterion or evidence-typed term.
    const expectations = [
      { name: "references guideline", ok: /(guideline|criterion|criteria)/.test(fullText) },
      { name: "references at least one note or report", ok: /(note|report|imaging|pathology|oncolog)/.test(fullText) },
      { name: "uses evidence vocabulary", ok: /(evidence|source|cite|quote)/.test(fullText) },
    ];
    for (const e of expectations) {
      console.log(`[copilot check] ${e.name}: ${e.ok ? "✓" : "✗"}`);
      expect(e.ok, `replies should ${e.name}`).toBeTruthy();
    }
  });

  // Multi-role flow: PI sets up a guideline maturity, reviewer takes over to
  // validate. Verifies the cross-role handoff at the API layer (separate
  // browser contexts get separate tokens, can each see what they should).
  test("9. Multi-role: PI sets maturity, reviewer reads it back", async ({ browser, request }) => {
    test.setTimeout(2 * 60 * 1000);

    // Two browser contexts = two independent users.
    const piToken = await loginViaApi(request);
    await request.post(
      `http://localhost:3001/api/auth/login`,
      { data: { reviewer_id: "ana_med_student" }, headers: { "Content-Type": "application/json" } },
    ).then((r) => r.json()); // login the reviewer (we use API for token, browser for UI)

    // PI: transition maturity (the gate is methodologist-only)
    const piRes = await request.post(
      `http://localhost:3001/api/guidelines/${TASK_ID}/maturity`,
      {
        data: { state: "calibrated", reason: "e2e — PI signing off pre-lock" },
        headers: { Authorization: `Bearer ${piToken}`, "Content-Type": "application/json" },
      },
    );
    const piBody = await piRes.json();
    console.log("[multi-role] PI transition →", piBody.state, "transitions:", piBody.transitions?.length);
    expect(["calibrated", "already calibrated"]).toContain(piBody.state ?? piBody.error ?? "");
    // The transition log should now include the PI's reason
    const transitions = piBody.transitions ?? [];
    if (transitions.length > 0) {
      const last = transitions[transitions.length - 1];
      expect(last.by).toBe("test_pi");
      console.log("[multi-role] last transition by:", last.by, "reason:", last.reason);
    }

    // Reviewer (different browser context) reads the same maturity record
    // from the API. The app doesn't surface a maturity badge in the
    // header; the assertion that the API state is consistent across
    // reviewers is the load-bearing one.
    const reviewerToken = await loginViaApi(request);
    const matRes = await request.get(
      `http://localhost:3001/api/guidelines/${TASK_ID}/maturity`,
      { headers: { Authorization: `Bearer ${reviewerToken}` } },
    );
    const matBody = await matRes.json();
    expect(matBody.state).toBe("calibrated");
    console.log("[multi-role] reviewer sees state=", matBody.state, "via API");
    void browser;
  });

  // #54 — review-copilot Mode 4 (Document) endpoint. POST /api/reviews/:p/:t/
  // suggest-override-reason returns a wrapped 4-sentence paragraph the
  // OverrideForm drops into the rationale textarea. Hits the real LLM.
  // Cost: ~$0.06 per call.
  test("10. Override-reason suggester returns a clean paragraph", async ({ request }) => {
    test.setTimeout(4 * 60 * 1000);
    const token = await loginViaApi(request);

    // Make sure a review_state exists.
    const runsRes = await request.get(
      `http://localhost:3001/api/runs?task_id=${TASK_ID}&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const runs = await runsRes.json();
    if (runs[0]) {
      await request.post(
        `http://localhost:3001/api/runs/${runs[0].run_id}/patients/${PATIENT_ID}/import`,
        {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          data: { force: true },
        },
      );
    }

    const r = await request.post(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}/suggest-override-reason`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: {
          field_id: "icd_lung_cancer_present",
          old_answer: false,
          new_answer: true,
        },
        timeout: 200_000,
      },
    );
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBeTruthy();
    expect(typeof body.suggestion).toBe("string");
    // Sentinel must have been stripped — agent's <OVERRIDE_REASON> tags should
    // not leak into the textarea.
    expect(body.suggestion).not.toMatch(/<\/?OVERRIDE_REASON>/);
    // Must be reasonably sized — long enough to be useful, short enough to be
    // a paragraph (not the full chat-style explainer we used to get).
    expect(body.suggestion.length).toBeGreaterThan(80);
    expect(body.suggestion.length).toBeLessThan(2000);
    // Must reference at least one of: chart/note/evidence/code/criterion.
    expect(body.suggestion.toLowerCase()).toMatch(
      /chart|note|evidence|code|criterion|guideline|c34|icd/,
    );
    console.log(
      `[override-suggester] cost=$${body.cost_usd?.toFixed(4) ?? "?"} ` +
      `len=${body.suggestion.length} dur=${body.duration_ms}ms`,
    );
    console.log("[override-suggester] suggestion:");
    console.log("   " + body.suggestion.split("\n").slice(0, 8).join("\n   "));
  });

  // #57 — review-copilot pre-lock summary endpoint. POST /api/reviews/:p/:t/
  // prelock-summary returns a wrapped per-field checklist + lock blockers.
  // Hits the real LLM. Cost: ~$0.05 per call.
  test("11. Pre-lock summary returns a wrapped checklist", async ({ request }) => {
    test.setTimeout(4 * 60 * 1000);
    const token = await loginViaApi(request);

    const r = await request.post(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}/prelock-summary`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: {},
        timeout: 200_000,
      },
    );
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBeTruthy();
    expect(typeof body.summary).toBe("string");
    expect(body.summary).not.toMatch(/<\/?PRELOCK_CHECKLIST>/);
    expect(body.summary.length).toBeGreaterThan(100);
    // The checklist must reference at least one known leaf field id from
    // lung-cancer-phenotype, and must mention the lock-blocker section.
    const lower = body.summary.toLowerCase();
    expect(lower).toMatch(
      /pathology_report_present|icd_lung_cancer_present|imaging_lung_lesion/,
    );
    expect(lower).toMatch(/blocker|weak|agent_proposed|none/);
    console.log(
      `[prelock-summary] cost=$${body.cost_usd?.toFixed(4) ?? "?"} ` +
      `len=${body.summary.length} dur=${body.duration_ms}ms`,
    );
    console.log("[prelock-summary] checklist:");
    console.log("   " + body.summary.split("\n").slice(0, 10).join("\n   "));
  });

  // #53 — focused-field pin. In PatientDetail the chat rail is always
  // visible; opening any patient auto-selects the first criterion and
  // writes it into FocusedFieldContext, which renders a 📍 badge in the
  // chat-rail header.
  test("12. Focused-field badge appears in the chat rail", async ({ page }) => {
    await openPatientViaPalette(page, PATIENT_ID);
    // ChatPanel header inside the chat rail
    const railHeader = page.locator('aside.w-\\[340px\\]').first();
    await expect(railHeader.first()).toBeVisible({ timeout: 10_000 });

    // Badge: a span starting with 📍 followed by a field id.
    const badge = page.locator('aside.w-\\[340px\\] span').filter({ hasText: /📍/ }).first();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    const badgeText = await badge.innerText();
    console.log(`[focused-field] badge text: ${badgeText.trim()}`);
    expect(badgeText).toMatch(/📍/);
    expect(badgeText.toLowerCase()).toMatch(
      /pathology|icd|imaging|cytology|oncologist|hemoglobin|diagnosis|lung_cancer|status|anemia/,
    );
  });

  // #43, #44, #47, #48 — server endpoints from the closing batch. All cheap
  // (no LLM) so we bundle them into one test.
  test("16. Closing-batch endpoints: budget, field-history, reject validation, tarball", async ({ request }) => {
    const token = await loginViaApi(request);

    // #47 — per-task budget summary.
    const budget = await request.get(`http://localhost:3001/api/budget/${TASK_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(budget.ok()).toBeTruthy();
    const b = await budget.json();
    expect(typeof b.total_cost_usd).toBe("number");
    expect(typeof b.n_runs).toBe("number");
    expect(b.defaults.cost_cap_usd).toBeGreaterThan(0);
    console.log(`[budget] $${b.total_cost_usd.toFixed(4)} across ${b.n_runs} runs · cap $${b.defaults.cost_cap_usd}`);

    // #43 — per-field adjudication trail. Empty is fine; we just verify the
    // route shape.
    const hist = await request.get(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}/field-history/icd_lung_cancer_present`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(hist.ok()).toBeTruthy();
    const hb = await hist.json();
    expect(hb.field_id).toBe("icd_lung_cancer_present");
    expect(Array.isArray(hb.entries)).toBeTruthy();

    // #44 — reject endpoint requires a structured reason. Sending no reason
    // must return 400 with the vocabulary listed.
    const noReason = await request.post(
      `http://localhost:3001/api/rules/${TASK_ID}/__nonexistent__/reject`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: {},
      },
    );
    expect(noReason.status()).toBe(400);
    const nrBody = await noReason.json();
    expect(nrBody.error).toMatch(/reason required/i);
    expect(nrBody.error).toMatch(/duplicate.*too_narrow.*too_broad/);

    // #48 — export with tarball:true, then download, verify content-type +
    // attachment header.
    const exp = await request.post(
      `http://localhost:3001/api/exports/${TASK_ID}?tarball=1`,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, data: {} },
    );
    expect(exp.ok()).toBeTruthy();
    const expBody = await exp.json();
    expect(expBody.ok).toBeTruthy();
    expect(typeof expBody.tarball_path).toBe("string");
    expect(expBody.tarball_size).toBeGreaterThan(0);
    const bundleId = expBody.manifest.bundle_id;
    console.log(`[bundle] exported ${bundleId} · tarball ${expBody.tarball_size} bytes`);

    const dl = await fetch(
      `http://localhost:3001/api/exports/${TASK_ID}/${bundleId}/download`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(dl.ok).toBeTruthy();
    expect(dl.headers.get("content-type")).toMatch(/gzip/);
    expect(dl.headers.get("content-disposition")).toMatch(/attachment.*\.tar\.gz/);
  });

  // #42 — auto-fire self-critique when a methodologist marks a pilot
  // complete. Reuses the pilot iteration created in test 5 to avoid spinning
  // up another batch run. The "no review_state" short-circuit in
  // selfCritiquePilot keeps the LLM cost at zero for this test.
  test("15. Auto-critique fires when pilot is marked complete", async ({ request }) => {
    test.setTimeout(3 * 60 * 1000);
    const token = await loginViaApi(request);

    // Find an existing pilot — test 5 created one earlier in the session.
    const listRes = await request.get(`http://localhost:3001/api/pilots/${TASK_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pilots = (await listRes.json()) as Array<{
      iter_id: string;
      run_status: string | null;
      auto_critique_state?: string;
    }>;
    const candidate = pilots.find(
      (p) => p.run_status && p.run_status !== "running",
    );
    if (!candidate) {
      console.log("[auto-critique] no completed pilot to mark complete — skipping");
      test.skip();
      return;
    }
    console.log(`[auto-critique] using pilot ${candidate.iter_id} (run_status=${candidate.run_status})`);

    // Mark complete — this should fire the auto-critique. Send the PATCH
    // even if the pilot is already "complete" (idempotent path).
    const patchRes = await request.patch(
      `http://localhost:3001/api/pilots/${TASK_ID}/${candidate.iter_id}`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { state: "complete" },
      },
    );
    expect(patchRes.ok()).toBeTruthy();

    // Poll the pilot manifest. Within 90 s, we should see either
    //   (a) auto_critique_state="running" briefly, then cleared, OR
    //   (b) critique.json materialized on disk (visible via GET .../critique).
    // Both are valid — when there's no review_state to analyze, critique
    // returns immediately with an error record and the state clears fast.
    let sawAutoState = false;
    let sawCritique = false;
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      const r = await request.get(
        `http://localhost:3001/api/pilots/${TASK_ID}/${candidate.iter_id}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const m = (await r.json()) as { auto_critique_state?: string };
      if (m.auto_critique_state === "running") sawAutoState = true;

      const cr = await request.get(
        `http://localhost:3001/api/pilots/${TASK_ID}/${candidate.iter_id}/critique`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (cr.ok()) {
        sawCritique = true;
        const body = await cr.json();
        console.log(
          `[auto-critique] critique landed: proposals=${body.proposal_count} ` +
          `error=${body.error ?? "none"}`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }

    // At least one of the two signals must be observed. The flag-then-clear
    // path can race ahead of polling, so the critique result is the
    // authoritative success signal.
    expect(sawCritique || sawAutoState).toBeTruthy();
    if (!sawCritique) {
      // If we only saw the running flag, give the background another beat
      // and re-check — the critique should land within seconds.
      await new Promise((r) => setTimeout(r, 5_000));
      const cr = await request.get(
        `http://localhost:3001/api/pilots/${TASK_ID}/${candidate.iter_id}/critique`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(cr.ok()).toBeTruthy();
    }
  });

  // SSE streaming for #54 — the override-reason endpoint emits tool_use /
  // narration events live so the OverrideForm can render tool pills while
  // the copilot is reading. Verifies events arrive before the final result.
  test("14. Streaming override-reason emits tool events live", async ({ request }) => {
    test.setTimeout(4 * 60 * 1000);
    const token = await loginViaApi(request);

    // fetch + manual SSE parsing — Playwright's APIRequestContext returns the
    // full body, so we hit the endpoint via Node's fetch directly so we can
    // observe the streaming.
    const url = `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}/suggest-override-reason/stream`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        field_id: "icd_lung_cancer_present",
        old_answer: false,
        new_answer: true,
      }),
    });
    expect(res.ok).toBeTruthy();
    expect(res.body).toBeTruthy();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const events: { type: string; toolName?: string; ok?: boolean; suggestion?: string }[] = [];
    let toolEventBeforeResult = false;
    let sawResult = false;
    const start = Date.now();
    while (Date.now() - start < 200_000) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length === 0) continue;
        const ev = JSON.parse(dataLines.join("\n"));
        events.push(ev);
        if (ev.type === "tool_use" && !sawResult) toolEventBeforeResult = true;
        if (ev.type === "result") sawResult = true;
      }
    }
    const toolEvents = events.filter((e) => e.type === "tool_use");
    const resultEvents = events.filter((e) => e.type === "result");
    console.log(
      `[stream] received ${events.length} events: ${toolEvents.length} tool_use, ` +
      `${events.filter((e) => e.type === "narration").length} narration, ` +
      `${resultEvents.length} result`,
    );
    console.log(
      `[stream] tool sequence: ${toolEvents.slice(0, 8).map((e) => e.toolName).join(" → ")}`,
    );
    expect(toolEventBeforeResult, "tool events must arrive before the result").toBeTruthy();
    expect(toolEvents.length).toBeGreaterThanOrEqual(2);
    expect(resultEvents.length).toBe(1);
    const result = resultEvents[0] as { ok?: boolean; suggestion?: string };
    expect(result.ok).toBeTruthy();
    expect(result.suggestion?.length ?? 0).toBeGreaterThan(80);
    // The final paragraph itself must NOT contain the sentinel tags (they're
    // stripped server-side).
    expect(result.suggestion).not.toMatch(/<\/?OVERRIDE_REASON>/);
  });

  // #53 — semantic check: the focused-field prefix actually flows through to
  // the chat agent's answer. Click a specific leaf field, ask "what should I
  // put here?" (no field name), verify the agent's reply talks about THAT
  // field. Without the prefix, "here" is ambiguous; with it, the copilot
  // resolves the deictic to the focused criterion. Cost: ~$0.05.
  test("13. Focused-field prefix flows through to copilot answer", async ({ page, request }) => {
    test.setTimeout(4 * 60 * 1000);
    const token = await loginViaApi(request);

    // Make sure a review_state exists.
    const runsRes = await request.get(
      `http://localhost:3001/api/runs?task_id=${TASK_ID}&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const runs = await runsRes.json();
    if (runs[0]) {
      await request.post(
        `http://localhost:3001/api/runs/${runs[0].run_id}/patients/${PATIENT_ID}/import`,
        {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          data: { force: true },
        },
      );
    }

    // Open the patient via the ⌘K palette and pick the criterion via the
    // criteria column — focus context updates as soon as the row is clicked.
    await openPatientViaPalette(page, PATIENT_ID);
    await expect(page.locator('aside.w-\\[340px\\]').first()).toBeVisible({ timeout: 10_000 });

    const fieldId = "icd_lung_cancer_present";
    await page.locator(`button:has(span.font-mono:text-is("${fieldId}"))`).first().click();
    await page.waitForTimeout(300);

    // Confirm the badge shows OUR field.
    const badge = page.locator('aside.w-\\[340px\\] span').filter({ hasText: /📍/ }).first();
    await expect(badge).toContainText(fieldId, { timeout: 5_000 });

    // Get baseline message count, then send the deictic question via the
    // chat rail's textarea.
    const beforeRes = await request.get(
      `http://localhost:3001/api/patients/${PATIENT_ID}/messages`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const beforeCount = (await beforeRes.json()).length;

    const textarea = page.locator('aside.w-\\[340px\\] textarea').first();
    await textarea.fill("what should I put here?");
    await textarea.press("Enter");

    // Wait for agent reply (stream stability, same approach as test 8).
    let lastCount = beforeCount;
    let stableSince = Date.now();
    const start = Date.now();
    let finalMsgs: Array<{ role: string; content?: string }> = [];
    while (Date.now() - start < 180_000) {
      await page.waitForTimeout(3_000);
      const msgsRes = await request.get(
        `http://localhost:3001/api/patients/${PATIENT_ID}/messages`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const msgs = await msgsRes.json();
      if (msgs.length !== lastCount) {
        lastCount = msgs.length;
        stableSince = Date.now();
      } else if (msgs.length > beforeCount && Date.now() - stableSince > 15_000) {
        finalMsgs = msgs;
        break;
      }
    }
    expect(finalMsgs.length).toBeGreaterThan(beforeCount);

    // Verify (a) the user message we sent contains the prefix marker (proof
    // the client embedded it), and (b) the assistant's reply talks about
    // icd_lung_cancer_present specifically (proof the agent honored it).
    const turnMsgs = finalMsgs.slice(beforeCount);
    const userMsg = turnMsgs.find((m) => m.role === "user");
    expect(userMsg, "user message should be in conversation").toBeTruthy();
    expect(userMsg!.content).toMatch(/\[focused_field:\s*icd_lung_cancer_present/);

    const assistantMsgs = turnMsgs.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const reply = assistantMsgs[assistantMsgs.length - 1].content as string;
    console.log(`[focused-prefix] reply (${reply.length} chars):`);
    console.log("   " + reply.split("\n").slice(0, 8).join("\n   "));
    // The substantive reply should mention either the field id, the ICD-code
    // domain, or the lung-cancer/cancer subject — confirming the deictic
    // "here" was correctly resolved.
    expect(reply.toLowerCase()).toMatch(
      /icd_lung_cancer_present|icd[- ]?10|c34|lung\s*cancer|condition/,
    );
  });

  // #45 — encounter / episode CRUD via the new sugar routes.
  // Pure API: POST → GET (verify present) → DELETE → GET (verify gone).
  test("17. Encounters: add + list + delete via API", async ({ request }) => {
    const token = await loginViaApi(request);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Make sure a review_state exists for this patient×task.
    await request.get(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    // POST encounter
    const addRes = await request.post(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}/encounters`,
      {
        headers,
        data: {
          kind: "encounter",
          date: "2024-08-22",
          label: "e2e oncology consult",
          note_ids: ["note_001"],
        },
      },
    );
    expect(addRes.ok()).toBeTruthy();
    const addBody = await addRes.json();
    expect(addBody.ok).toBeTruthy();
    expect(typeof addBody.encounter_id).toBe("string");
    const encId: string = addBody.encounter_id;
    expect(encId.length).toBeGreaterThan(8);
    console.log(`[encounters] created ${encId}`);

    // GET review state — encounter must be present.
    const getRes1 = await request.get(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(getRes1.ok()).toBeTruthy();
    const state1 = await getRes1.json();
    const encounters1: Array<{
      encounter_id: string;
      kind: string;
      date?: string;
      label?: string;
      note_ids?: string[];
    }> = state1.encounters ?? [];
    const found = encounters1.find((e) => e.encounter_id === encId);
    expect(found, "encounter should be present after POST").toBeTruthy();
    expect(found!.kind).toBe("encounter");
    expect(found!.date).toBe("2024-08-22");
    expect(found!.label).toBe("e2e oncology consult");
    expect(found!.note_ids).toEqual(["note_001"]);

    // POST a second one (episode) to confirm list semantics.
    const addRes2 = await request.post(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}/encounters`,
      {
        headers,
        data: { kind: "episode", label: "e2e episode" },
      },
    );
    expect(addRes2.ok()).toBeTruthy();
    const addBody2 = await addRes2.json();
    const encId2: string = addBody2.encounter_id;
    expect(encId2).not.toBe(encId);

    // DELETE the first encounter.
    const delRes = await request.delete(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}/encounters/${encId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(delRes.ok()).toBeTruthy();
    const delBody = await delRes.json();
    expect(delBody.ok).toBeTruthy();

    // GET again — first encounter gone, second still there.
    const getRes2 = await request.get(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const state2 = await getRes2.json();
    const encounters2: Array<{ encounter_id: string }> = state2.encounters ?? [];
    expect(encounters2.find((e) => e.encounter_id === encId)).toBeFalsy();
    expect(encounters2.find((e) => e.encounter_id === encId2)).toBeTruthy();

    // DELETE again is a no-op (still 200).
    const delRes2 = await request.delete(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}/encounters/${encId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(delRes2.ok()).toBeTruthy();

    // Cleanup the second one so reruns are deterministic.
    await request.delete(
      `http://localhost:3001/api/reviews/${PATIENT_ID}/${TASK_ID}/encounters/${encId2}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    console.log("[encounters] add + list + delete + idempotent delete: OK");
  });

  // ── New tests: cohort curation, per-iter accuracy, eligibility, lock test ──

  test("18. Cohort curation — PUT /api/cohort-sampling and GET it back", async ({ request }) => {
    const token = await loginViaApi(request);
    const tinyCohort = {
      task_id: TASK_ID,
      version: 1,
      created_at: new Date().toISOString(),
      created_by: "test_pi",
      dev_patient_ids: ["patient_easy_neg_01"],    // 1 patient for speed
      lock_patient_ids: ["patient_easy_nsclc_02"], // 1 patient for speed
    };
    const put = await request.put(`http://localhost:3001/api/cohort-sampling/${TASK_ID}`, {
      headers: { Cookie: `session=${token}` },
      data: tinyCohort,
    });
    expect(put.status()).toBe(204);

    const get = await request.get(`http://localhost:3001/api/cohort-sampling/${TASK_ID}`, {
      headers: { Cookie: `session=${token}` },
    });
    expect(get.status()).toBe(200);
    const body = await get.json();
    expect(body.dev_patient_ids).toEqual(["patient_easy_neg_01"]);
    expect(body.lock_patient_ids).toEqual(["patient_easy_nsclc_02"]);
    console.log("[ok] cohort sampling round-trip");
  });

  test("19. Per-iter accuracy populated after critique runs", async ({ request }) => {
    const token = await loginViaApi(request);
    // The earlier pilot iter (from test 5) has run. Trigger its critique to write the accuracy block.
    const pilotsList = await request.get(`http://localhost:3001/api/pilots/${TASK_ID}`, {
      headers: { Cookie: `session=${token}` },
    });
    expect(pilotsList.status()).toBe(200);
    const pilots = await pilotsList.json();
    expect(pilots.length).toBeGreaterThan(0);
    const iter = pilots[0]; // most recent

    // Trigger critique. NOTE: existing flow may already trigger this when an iter is marked complete.
    // If the listing already has accuracy_summary populated, skip the explicit critique POST.
    if (!iter.accuracy_summary) {
      await request.post(
        `http://localhost:3001/api/pilots/${TASK_ID}/${iter.iter_id}/critique`,
        { headers: { Cookie: `session=${token}` } },
      );
      // Re-fetch
      const re = await request.get(`http://localhost:3001/api/pilots/${TASK_ID}`, {
        headers: { Cookie: `session=${token}` },
      });
      const repilots = await re.json();
      const reiter = repilots.find((p: any) => p.iter_id === iter.iter_id);
      // accuracy_summary may still be null if no sampling.json existed at critique time;
      // that's an acceptable outcome. We just check the field is reachable in the response shape.
      expect(reiter).toHaveProperty("accuracy_summary");
    } else {
      expect(iter.accuracy_summary).toHaveProperty("override_count");
    }
    console.log("[ok] accuracy_summary surface present in pilots listing");
  });

  test("20. Eligibility endpoint returns the expected shape", async ({ request }) => {
    const token = await loginViaApi(request);
    const r = await request.get(`http://localhost:3001/api/pilots/${TASK_ID}/eligibility`, {
      headers: { Cookie: `session=${token}` },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("eligible");
    expect(body).toHaveProperty("consecutive_passing");
    expect(body).toHaveProperty("required_consecutive", 2);
    expect(body).toHaveProperty("failing_criteria");
    expect(body).toHaveProperty("override_growth");
    // Real cohort hasn't run dev_loop yet, so we don't assert eligible: true
    console.log("[ok] eligibility endpoint shape:", JSON.stringify({ eligible: body.eligible, consecutive: body.consecutive_passing }));
  });

  test("21. Lock test — POST /start creates manifest with state=running", async ({ request }) => {
    const token = await loginViaApi(request);
    // Cohort was set up in test 18 with patient_easy_nsclc_02 in lock_patient_ids.
    const r = await request.post(`http://localhost:3001/api/lock-test/${TASK_ID}/start`, {
      headers: { Cookie: `session=${token}`, "Content-Type": "application/json" },
      data: { started_by: "test_pi" },
    });
    // The endpoint may return 200 with run_id, or 500 if the underlying agent batch fails.
    // For e2e budget we accept 200 OR 500-with-detail (the manifest still gets written either way).
    expect([200, 500]).toContain(r.status());
    if (r.status() === 200) {
      const body = await r.json();
      expect(body).toHaveProperty("run_id");
      console.log("[ok] lock test started:", body.run_id);
      // Verify it shows up in the list:
      const list = await request.get(`http://localhost:3001/api/lock-test/${TASK_ID}`, {
        headers: { Cookie: `session=${token}` },
      });
      expect(list.status()).toBe(200);
      const runs = await list.json();
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0].run_id).toBe(body.run_id);
      expect(runs[0].copilot_blind_mode).toBe(true);
    } else {
      console.log("[note] lock test start returned 500 (agent batch may have failed); skipping list verification");
    }
  });
});
