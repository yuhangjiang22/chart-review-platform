// @vitest-environment jsdom
//
// AdherenceReview regression tests (FILE 3 of the adversarial-review fixes).
// Covers:
//   - numeric-enum coercion: an enum question with enum:[1,2,3] where the
//     agent answered the NUMBER 2 and the reviewer selects "2" must match
//     (the "= A1" source label appears) — no phantom disagree.
//   - un-adjudicated rule: a rule with NO engine verdict must NOT pre-select
//     NON_CONCORDANT, must NOT show the attribution sub-row, and the
//     Accept/Save button must be disabled (so nothing is written).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from "../auth";
import { AdherenceReview } from "../ui/AdherenceReview";

const mockAuthFetch = authFetch as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

// framework: one numeric-enum question, one rule (the rule has no verdict).
const FRAMEWORK = {
  ok: true,
  questions_by_tier: {
    "1": [
      {
        question_id: "act_score_band",
        text: "ACT score band",
        tier: 1,
        answer_schema: { type: "number", enum: [1, 2, 3] },
      },
    ],
  },
  rules: [
    {
      rule_id: "r_controller_use",
      description: "Controller prescribed when indicated",
      verdict_if: "act_score_band <= 2",
      supporting_questions: ["act_score_band"],
    },
  ],
  attribution_categories: ["DOCUMENTATION_GAP", "GUIDELINE_DEVIATION"],
};

// review state: agent_1 answered the NUMBER 2; no rule_verdicts at all.
const REVIEW_STATE = {
  patient_id: "p1",
  task_id: "asthma-adherence",
  version: 1,
  task_kind: "adherence",
  imported_from_run: "run-1",
  question_answers: [
    { question_id: "act_score_band", tier: 1, answer: 2, source: "agent" },
  ],
  rule_verdicts: [],
  validated_questions: [],
  validated_rules: [],
  agent_question_answers: {
    agent_1: [{ question_id: "act_score_band", tier: 1, answer: 2, source: "agent" }],
  },
  agent_rule_verdicts: {},
};

function setupMocks() {
  mockAuthFetch.mockImplementation((url: string) => {
    if (url.includes("/adherence") && url.includes("/api/tasks/")) return okJson(FRAMEWORK);
    if (url.includes("/api/reviews/")) return okJson(REVIEW_STATE);
    if (url.includes("/api/runs")) return okJson([]);
    return okJson(null);
  });
}

function renderPane(opts: { blind?: boolean; activeSessionName?: string | null } = {}) {
  return render(
    <AdherenceReview
      patientId="p1"
      patientDisplay="Patient 1"
      taskId="asthma-adherence"
      onBack={() => {}}
      activeSessionId="sess-1"
      activeSessionName={opts.activeSessionName}
      blind={opts.blind}
    />,
  );
}

/** All authFetch calls whose URL contains `fragment`. */
function callsTo(fragment: string): Array<[string, RequestInit?]> {
  return (mockAuthFetch.mock.calls as Array<[string, RequestInit?]>).filter(
    ([url]) => url.includes(fragment),
  );
}

describe("AdherenceReview — numeric-enum coercion", () => {
  it("matches a numeric-enum agent answer (2) when the reviewer selects '2' — no phantom disagree", async () => {
    setupMocks();
    renderPane();

    // Wait for the enum select to render with the agent's value preselected.
    const select = await waitFor(() => {
      const sel = screen.getAllByRole("combobox").find((el) => (el as HTMLSelectElement).value === "2");
      expect(sel).toBeTruthy();
      return sel as HTMLSelectElement;
    });

    // The Reviewer column source label should credit agent A1 (the draft
    // equals the agent's typed number). With the bug, draft="2" (string) !==
    // agent 2 (number) and the label would be blank.
    expect(screen.getByText(/=\s*A1/)).toBeInTheDocument();

    // Re-selecting "2" must keep the number type → still matches → label
    // stays "= A1" (phantom-disagree regression guard).
    fireEvent.change(select, { target: { value: "2" } });
    await waitFor(() => {
      expect(screen.getByText(/=\s*A1/)).toBeInTheDocument();
    });
  });
});

describe("AdherenceReview — un-adjudicated rule", () => {
  it("does NOT pre-select NON_CONCORDANT and disables Save for a rule with no verdict", async () => {
    setupMocks();
    renderPane();

    // Find the rule verdict <select> (the one with a "— select verdict —"
    // option). It must default to "" (neutral), not NON_CONCORDANT.
    const verdictSelect = await waitFor(() => {
      const sel = screen
        .getAllByRole("combobox")
        .find((el) => within(el as HTMLElement).queryByText("— select verdict —"));
      expect(sel).toBeTruthy();
      return sel as HTMLSelectElement;
    });
    expect(verdictSelect.value).toBe("");

    // The NON_CONCORDANT attribution sub-row must NOT be shown.
    expect(screen.queryByText("— attribution —")).not.toBeInTheDocument();

    // The Accept/Save button for this rule must be disabled.
    const acceptBtns = screen.getAllByRole("button", { name: /accept/i });
    expect(acceptBtns.length).toBeGreaterThan(0);
    // The rule-row Accept button is disabled while the verdict is "".
    expect(acceptBtns.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});

// review state used by the "no auto-import in blind mode" and "seed-events
// exactly once" tests: empty question_answers, no rule_events, AND no
// imported_from_run/agent shadow — the exact shape that makes the non-blind
// seed-on-empty auto-import chain fire (were it not blind-guarded) while
// staying UNCONTAMINATED per isBlindContaminated (so the pane renders
// normally instead of the refusal panel).
const REVIEW_STATE_NEVER_IMPORTED = {
  ...REVIEW_STATE,
  question_answers: [],
  agent_question_answers: {},
};
delete (REVIEW_STATE_NEVER_IMPORTED as { imported_from_run?: string }).imported_from_run;

// Fixture for the "key test" (defense-in-depth, no contamination-refusal):
// question_answers + rule_verdicts carry source:"agent" DIRECTLY on the
// canonical arrays, and the one rule_event carries an agent-sourced answer
// too — but imported_from_run is unset and the agent shadow maps
// (agent_question_answers/agent_rule_verdicts/agent_rule_events) are absent,
// so isBlindContaminated does NOT trip and the pane renders its normal
// controls. This isolates the per-control reviewer-only filter (Critical 2b)
// from the hard contamination-refusal gate (Critical 2a, tested separately
// below by adding imported_from_run to this SAME fixture).
const AGENT_POPULATED_UNCONTAMINATED_STATE = {
  patient_id: "p1",
  task_id: "asthma-adherence",
  version: 1,
  task_kind: "adherence",
  question_answers: [
    { question_id: "act_score_band", tier: 1, answer: 2, source: "agent" },
  ],
  rule_verdicts: [
    { rule_id: "r_controller_use", verdict: "CONCORDANT", source: "rule_engine" },
  ],
  validated_questions: [],
  validated_rules: [],
  rule_events: [
    {
      event_id: "ev_1",
      rule_id: "r_controller_use",
      anchor: { type: "encounter", date: "2025-03-01", origin: "note", ref: "note_1" },
      evaluable: true,
      answers: [{ question_id: "act_score_band", tier: 1, answer: 2, source: "agent" }],
      verdict: "CONCORDANT",
      source: "agent",
    },
    // Task 5 re-review, IMPORTANT 1: a SECOND event, evaluable:false with an
    // agent-authored evaluable_reason — the "key" fixture above dodged this
    // leak entirely by using evaluable:true on its only event.
    {
      event_id: "ev_2",
      rule_id: "r_controller_use",
      anchor: { type: "encounter", date: "2025-04-01", origin: "note", ref: "note_2" },
      evaluable: false,
      evaluable_reason: "chart note says therapy discontinued (agent-authored, must not leak)",
      verdict: "EXCLUDED",
      source: "agent",
    },
  ],
  rule_rollups: [],
  validated_events: [],
};

function setupMocksWith(state: unknown) {
  mockAuthFetch.mockImplementation((url: string) => {
    if (url.includes("/adherence") && url.includes("/api/tasks/")) return okJson(FRAMEWORK);
    if (url.includes("/api/reviews/")) return okJson(state);
    if (url.includes("/api/runs")) return okJson([]);
    return okJson(null);
  });
}

describe("AdherenceReview — blind mode (spec 2026-08-24 Task 5 review)", () => {
  it("KEY: no agent value reaches the DOM — form values are empty, not just text-hidden (defense-in-depth, Critical 2b)", async () => {
    setupMocksWith(AGENT_POPULATED_UNCONTAMINATED_STATE);
    renderPane({ blind: true });

    await waitFor(() => {
      expect(screen.getByText("ACT score band")).toBeInTheDocument();
    });

    // Every <select> on the page — the question's Reviewer control, the
    // rule's verdict control, AND the event row's per-answer control (all
    // three use the same enum-typed act_score_band question, so all three
    // render as comboboxes here) — must sit at its neutral/empty value.
    // None may leak the agent's answer (2) or the agent's rule verdict
    // (CONCORDANT). Checking the ACTUAL FORM VALUE, not text presence, is
    // the point: a text query alone can't see this leak — that's exactly
    // how it survived the first pass.
    const comboboxes = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(comboboxes.length).toBeGreaterThanOrEqual(3); // question + rule-verdict + event-answer
    expect(comboboxes.every((cb) => cb.value === "")).toBe(true);

    // No "(A)" agent-provenance tag anywhere (RuleRow's Inputs: line).
    expect(screen.queryByText(/\(A\)/)).not.toBeInTheDocument();
    // No "= A1" agent-source hint on the Reviewer column either.
    expect(screen.queryByText(/=\s*A1/)).not.toBeInTheDocument();
    // Task 5 re-review, IMPORTANT 1: ev_2's agent-authored evaluable_reason
    // (event.source:"agent", evaluable:false) must not print either — it's
    // free text (the MCP tool takes z.string().optional()), rendered right
    // above the very control this file otherwise refuses to seed for a
    // non-reviewer event.
    expect(screen.queryByText(/agent-authored, must not leak/)).not.toBeInTheDocument();
  });

  it("the SAME agent-authored evaluable_reason DOES render in non-blind mode (control case, proves the assertion above isn't vacuous)", async () => {
    setupMocksWith(AGENT_POPULATED_UNCONTAMINATED_STATE);
    renderPane({ blind: false });

    await waitFor(() => {
      expect(screen.getByText(/agent-authored, must not leak/)).toBeInTheDocument();
    });
  });

  it("contamination refusal: the SAME fixture + imported_from_run set → hard error panel, no controls (Critical 2a)", async () => {
    setupMocksWith({ ...AGENT_POPULATED_UNCONTAMINATED_STATE, imported_from_run: "run-1" });
    renderPane({ blind: true });

    await waitFor(() => {
      expect(
        screen.getByText(/This session contains agent output — it cannot be used for blind gold collection/),
      ).toBeInTheDocument();
    });

    // The banner still shows (spec: "Keep the banner visible; no controls").
    expect(screen.getByText(/BLIND MODE/)).toBeInTheDocument();
    // But NOTHING reviewer-editable renders — no comboboxes, no text
    // inputs, and no Accept/Save buttons (the Header's own "Back"
    // navigation button is the only button left — it isn't part of the
    // annotation surface this gate is protecting).
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /accept|save/i })).not.toBeInTheDocument();
    expect(screen.queryByText("ACT score band")).not.toBeInTheDocument();
  });

  it("MODERATE: a contaminated blind session with empty rule_events does NOT POST to seed-events (never seeds into a state the pane refuses to show)", async () => {
    // REVIEW_STATE: imported_from_run set AND a non-empty agent_question_answers
    // shadow (both contaminating) AND no rule_events key at all (the exact
    // shape that would otherwise trigger the seed-on-empty chain).
    setupMocks();
    renderPane({ blind: true });

    await waitFor(() => {
      expect(
        screen.getByText(/This session contains agent output — it cannot be used for blind gold collection/),
      ).toBeInTheDocument();
    });
    // Give any (incorrectly) in-flight seed chain a real chance to fire.
    await new Promise((r) => setTimeout(r, 50));

    expect(callsTo("/adherence/seed-events")).toHaveLength(0);
  });

  it("never calls the run-import endpoint, even with empty question_answers and no imported_from_run", async () => {
    mockAuthFetch.mockImplementation((url: string) => {
      if (url.includes("/adherence") && url.includes("/api/tasks/")) return okJson(FRAMEWORK);
      if (url.includes("/api/reviews/")) return okJson(REVIEW_STATE_NEVER_IMPORTED);
      if (url.includes("/api/runs")) return okJson([{ run_id: "run-1" }]);
      return okJson(null);
    });
    renderPane({ blind: true });

    await waitFor(() => {
      expect(screen.getByText("ACT score band")).toBeInTheDocument();
    });
    // Give the blind seed-events chain (which DOES legitimately fire for
    // this empty-rule_events fixture) time to settle, so we're asserting
    // against the chain's steady state, not an in-flight snapshot.
    await waitFor(() => {
      expect(callsTo("/adherence/seed-events").length).toBeGreaterThan(0);
    });

    expect(callsTo("/import")).toHaveLength(0);
    expect(callsTo("/api/runs")).toHaveLength(0);
  });

  it("with empty rule_events, calls /adherence/seed-events exactly once", async () => {
    setupMocksWith(REVIEW_STATE_NEVER_IMPORTED);
    renderPane({ blind: true });

    await waitFor(() => {
      expect(screen.getByText("ACT score band")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(callsTo("/adherence/seed-events").length).toBe(1);
    });
    // The post-seed refresh must have landed too (a second /api/reviews/
    // read), proving the guard ref — not a stalled request — is what caps
    // the count at one.
    await waitFor(() => {
      expect(callsTo("/api/reviews/").length).toBeGreaterThanOrEqual(2);
    });
    expect(callsTo("/adherence/seed-events")).toHaveLength(1);
  });

  it("renders the blind-mode banner (with the session name) when blind, and never renders it otherwise (Critical 3)", async () => {
    setupMocksWith(REVIEW_STATE_NEVER_IMPORTED);
    const { unmount } = renderPane({ blind: true, activeSessionName: "blind-v06" });
    await waitFor(() => {
      expect(screen.getByText(/BLIND MODE/)).toBeInTheDocument();
    });
    expect(
      screen.getByText('BLIND MODE — writing gold to session "blind-v06" — agent output hidden'),
    ).toBeInTheDocument();
    unmount();

    // No session name known yet → generic banner text (not blank/broken).
    setupMocksWith(REVIEW_STATE_NEVER_IMPORTED);
    const { unmount: unmount2 } = renderPane({ blind: true, activeSessionName: null });
    await waitFor(() => {
      expect(
        screen.getByText(/BLIND MODE — agent output hidden; your answers become the gold standard/),
      ).toBeInTheDocument();
    });
    unmount2();

    setupMocks();
    renderPane({ blind: false });
    await waitFor(() => {
      expect(screen.getByText("ACT score band")).toBeInTheDocument();
    });
    expect(screen.queryByText(/BLIND MODE/)).not.toBeInTheDocument();
  });
});
