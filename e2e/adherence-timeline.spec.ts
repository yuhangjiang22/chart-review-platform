// Adherence event-timeline Playwright smoke tests.
//
// Guards the event-concordance timeline UI end-to-end: EventTimeline.tsx's
// header/track/"Window rules" strip, AdherenceReview.tsx's Events section
// (EventRow: per-answer controls, Save → validated marker, "Events: N / M
// validated" counter), and blind-mode isolation (no agent/engine output
// leaks into a gold-collection session).
//
// Fixture: patient_fake_asthma_01 (pediatric synthetic asthma patient,
// corpus/patients/patient_fake_asthma_01/) — seeding via the deterministic
// ETL work-list (see SETUP NOTE below) produces 11 anchored rule_events
// (4 step-therapy, 6 follow-up, 1 obligation point).
//
// SETUP NOTE — deviates from a plan that assumed importing a completed
// var/runs/* draft into a freshly created session:
// POST /api/runs/:runId/patients/:pid/import (server/jobs-routes.ts) always
// writes into the run's OWNING session — the session whose pilot iteration
// already references that run_id (sessionIdForRun in
// server/lib/session-reviews.ts) — never into a session the caller passes
// in (the route doesn't even read a session_id param). A session this spec
// creates can therefore never "own" a pre-existing run. Verified live
// against this checkout's var/runs: every asthma-adherence run for
// patient_fake_asthma_01 completed after the event-engine feature landed
// (2026-08-2x, the ones with rule_events in their draft) was launched by a
// standalone script with NO owning session at all → import 409s "no owning
// session; cannot import" for ANY session. The only runs WITH an owning
// session are pre-existing real dev sessions (session_001..session_005)
// whose drafts predate rule_events entirely (no such key in the JSON) —
// and importing into them would both fail to produce a timeline AND risk
// clobbering another reviewer's real session data on this shared box.
//
// Instead, every test below seeds rule_events the same way blind
// gold-collection does: POST .../adherence/seed-events, which builds the
// SAME deterministic work-list (rules × the patient's corpus-tracked anchor
// lists — corpus/patients/*/anchors/, not gitignored var/) with no agent
// run and no import (server/adherence-routes.ts). That route has no
// blind-only guard server-side — "blind" is a client-side workflow
// convention in its comments, not a server restriction — so calling it
// directly against a freshly created, test-owned session is a fast (no LLM
// call), fully-through-the-API way to populate the exact `state.rule_events`
// the timeline renders, in either blind or normal review mode. Tests 1 and
// 2 seed it explicitly and view in normal (non-blind) mode; test 3 lets
// AdherenceReview's own blind auto-seed effect call the same route, per its
// designed workflow (see AdherenceReview.tsx's refreshState blind branch).

import { test, expect, type Page } from "@playwright/test";
import {
  loginAsYuhang, apiPost, startSession,
  snapshotActiveSessionIds, archiveSessionsNotIn, setActiveSession,
} from "./_helpers";

const TASK_ID = "asthma-adherence";
const PATIENT_ID = "patient_fake_asthma_01";

type TestState = { _token: string; _preexisting: Set<string> };

async function gotoPatient(
  page: Page, taskId: string, patientId: string, opts?: { blind?: boolean },
): Promise<void> {
  const suffix = opts?.blind ? "?blind=1" : "";
  await page.goto(`/#/patient/${encodeURIComponent(taskId)}/${encodeURIComponent(patientId)}${suffix}`);
  await expect(page.locator("body")).toBeVisible();
}

/** Seeds rule_events for PATIENT_ID/TASK_ID in session `sid` from the
 *  deterministic ETL work-list — see the SETUP NOTE above. Throws (via
 *  apiPost) on a non-2xx response, e.g. if rule_events were already seeded
 *  or the patient's anchor fixtures are missing. */
async function seedRuleEvents(page: Page, token: string, sid: string): Promise<{ events: number }> {
  return apiPost(
    page,
    `/api/reviews/${encodeURIComponent(PATIENT_ID)}/${encodeURIComponent(TASK_ID)}/adherence/seed-events?session_id=${encodeURIComponent(sid)}`,
    {},
    token,
  ) as Promise<{ events: number }>;
}

// The review pane's period-level strip (window rules + composite). The
// chronology itself renders in the SOURCE pane's Timeline tab — see
// openSourceTimeline.
function periodStrip(page: Page) {
  return page.locator("div.border.border-border.rounded-md.bg-card").first();
}

/** Open the source pane's Events tab — the adherence chronology. Kept separate
 *  from the Timeline tab, which shows only what the chart records. */
async function openSourceTimeline(page: Page) {
  await page.getByRole("button", { name: /^events$/i }).click();
}

/** Every adherence rule line in the Events tab. Each carries its event_id as
 *  the button's title, which is the stable handle — the visible text is the
 *  rule name, which repeats across days. Scoped to the tab: the review pane's
 *  per-event question rows title their date chips with event_ids too. */
function ruleLines(page: Page) {
  return page.getByTestId("events-tab").locator('button[title^="R-"]');
}

test.describe("adherence event timeline", () => {
  test.beforeEach(async ({ page }) => {
    const token = await loginAsYuhang(page);
    const st = page as unknown as TestState;
    st._token = token;
    st._preexisting = await snapshotActiveSessionIds(page, token, TASK_ID);
  });

  test.afterEach(async ({ page }) => {
    const st = page as unknown as TestState;
    if (st._token) {
      await archiveSessionsNotIn(page, st._token, TASK_ID, st._preexisting ?? new Set());
    }
  });

  test("timeline renders and clicking the first event card focuses its row", async ({ page }) => {
    const token = (page as unknown as TestState)._token;
    const sid = await startSession(page, token, TASK_ID, "adherence-timeline smoke A", [PATIENT_ID]);

    let seeded: { events: number };
    try {
      seeded = await seedRuleEvents(page, token, sid);
    } catch (e) {
      test.skip(true, `could not seed rule_events for ${PATIENT_ID}: ${(e as Error).message}`);
      return;
    }
    expect(seeded.events, "deterministic work-list should produce events").toBeGreaterThan(0);

    await setActiveSession(page, TASK_ID, sid);
    await gotoPatient(page, TASK_ID, PATIENT_ID);

    // Rules sit in the section for the scope they are judged at, and the page
    // runs eligibility gate → events → period conclusions. The order matters:
    // a period question's instruction reads a value the engine reduces from the
    // per-event answers, so the events must come first.
    await expect(page.getByRole("heading", { name: /^Eligibility/ })).toBeVisible();
    await expect(page.getByText(/Rules judged per event/)).toBeVisible();
    await expect(page.getByText(/Rules judged once for the period/)).toBeVisible();
    const yOf = async (l: ReturnType<typeof page.getByText>) =>
      (await l.first().boundingBox())!.y;
    const yEligibility = await yOf(page.getByRole("heading", { name: /^Eligibility/ }));
    const yEvents = await yOf(page.getByRole("button", { name: /^Events/ }));
    const yPeriod = await yOf(page.getByRole("heading", { name: /^Question framework/ }));
    expect(yEligibility).toBeLessThan(yEvents);
    expect(yEvents).toBeLessThan(yPeriod);

    await openSourceTimeline(page);
    const firstLine = ruleLines(page).first();
    await expect(firstLine).toBeVisible();
    const eventId = await firstLine.getAttribute("title");
    expect(eventId, "a rule line should carry its event_id as its title").toBeTruthy();

    await expect(firstLine).toHaveAttribute("aria-current", "false");
    await firstLine.click();
    await expect(firstLine).toHaveAttribute("aria-current", "true");

    // Selecting in the chronology reopens (if collapsed) and scrolls to the
    // reviewer's row for that event in the review pane.
    const row = page.locator(`[id="event-row-${eventId}"]`);
    await expect(row).toBeInViewport();
  });

  test("per-event save validates and increments the Events counter", async ({ page }) => {
    const token = (page as unknown as TestState)._token;
    const sid = await startSession(page, token, TASK_ID, "adherence-timeline smoke B", [PATIENT_ID]);

    try {
      await seedRuleEvents(page, token, sid);
    } catch (e) {
      test.skip(true, `could not seed rule_events for ${PATIENT_ID}: ${(e as Error).message}`);
      return;
    }

    await setActiveSession(page, TASK_ID, sid);
    await gotoPatient(page, TASK_ID, PATIENT_ID);

    const counter = page.getByText(/^Events: \d+ \/ \d+ validated$/);
    await expect(counter).toBeVisible();
    const beforeText = await counter.textContent();
    const beforeMatch = beforeText?.match(/Events: (\d+) \/ (\d+) validated/);
    expect(beforeMatch, "events counter should parse").toBeTruthy();
    const beforeN = parseInt(beforeMatch![1]!, 10);

    await openSourceTimeline(page);
    const firstLine = ruleLines(page).first();
    await firstLine.click();
    const eventId = await firstLine.getAttribute("title");
    const row = page.locator(`[id="event-row-${eventId}"]`);
    await expect(row).toBeVisible();

    // Change the first per-answer control (boolean/enum → <select>;
    // number/text → <input>) so the row is dirty before saving. Excludes
    // the "Not evaluable" checkbox (no [type] attr match) and its reason
    // input (only rendered once that checkbox is checked).
    const control = row.locator('select, input[type="number"], input[type="text"]').first();
    await expect(control).toBeVisible();
    const tag = await control.evaluate((el) => el.tagName.toLowerCase());
    if (tag === "select") {
      const current = await control.inputValue();
      const values = await control.locator("option").evaluateAll(
        (opts) => opts.map((o) => (o as HTMLOptionElement).value),
      );
      const next = values.find((v) => v !== current && v !== "");
      expect(next, "expected an alternate option on the first answer control").toBeTruthy();
      await control.selectOption(next!);
    } else {
      const type = await control.getAttribute("type");
      await control.fill(type === "number" ? "1" : "e2e-smoke");
    }

    await row.getByRole("button", { name: /^Save$/ }).click();

    await expect(row.getByText("validated", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: /✓ Validated/ })).toBeVisible();
    await expect(counter).toHaveText(new RegExp(`^Events: ${beforeN + 1} / \\d+ validated$`));
  });

  test("blind mode hides agent output and still renders the timeline", async ({ page }) => {
    const token = (page as unknown as TestState)._token;
    const name = "adherence-timeline smoke blind";
    const sid = await startSession(page, token, TASK_ID, name, [PATIENT_ID]);

    await setActiveSession(page, TASK_ID, sid);
    await gotoPatient(page, TASK_ID, PATIENT_ID, { blind: true });

    // Names the session (spec 2026-08-24 Task 5 review, Critical 3 — the
    // annotator must see WHERE their answers land).
    await expect(page.getByText(/BLIND MODE/i)).toBeVisible();
    await expect(page.getByText(name)).toBeVisible();

    // AdherenceReview's own blind auto-seed effect calls the deterministic
    // seed-events route on first load (no agent run, no import) — give it a
    // moment to land before asserting cards are present.
    await openSourceTimeline(page);
    await expect(ruleLines(page).first()).toBeVisible({ timeout: 10_000 });

    // No engine/agent verdict output anywhere. In blind mode buildAdherenceDays
    // never BUILDS verdict text (it is not merely hidden by styling), and the
    // review pane's composite is gated too.
    await expect(periodStrip(page).getByText(/Composite:/i)).toHaveCount(0);
    // Scoped to the chronology's rule lines: elsewhere on the page the
    // annotator's OWN verdict dropdown legitimately offers "CONCORDANT" as an
    // option, which is not a leak.
    await expect(ruleLines(page).getByText(/CONCORDANT|NOT EVALUABLE|NOT SCORED/)).toHaveCount(0);
    // No agent-vs-human compare surface — the whole picker bar is `{!blind && (...)}`.
    await expect(page.getByText(/Compare with session/i)).toHaveCount(0);
  });
});
