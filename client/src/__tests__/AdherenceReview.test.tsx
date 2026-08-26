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

function renderPane(opts: { blind?: boolean } = {}) {
  return render(
    <AdherenceReview
      patientId="p1"
      patientDisplay="Patient 1"
      taskId="asthma-adherence"
      onBack={() => {}}
      activeSessionId="sess-1"
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

// review state used by the "no auto-import in blind mode" test: empty
// question_answers AND no imported_from_run — the exact shape that makes
// the non-blind seed-on-empty auto-import chain fire.
const REVIEW_STATE_NEVER_IMPORTED = {
  ...REVIEW_STATE,
  question_answers: [],
  agent_question_answers: {},
};
delete (REVIEW_STATE_NEVER_IMPORTED as { imported_from_run?: string }).imported_from_run;

describe("AdherenceReview — blind mode (spec 2026-08-24 Task 5)", () => {
  it("hides agent-sourced values (A/B column + '= A1' source hint) that ARE visible in non-blind mode", async () => {
    setupMocks();
    renderPane({ blind: true });

    // Wait for the framework to load (same question as the non-blind test
    // above, which asserts the "A1" column + "= A1" hint DO render for this
    // exact fixture when blind is false/omitted).
    await waitFor(() => {
      expect(screen.getByText("ACT score band")).toBeInTheDocument();
    });

    expect(screen.queryByText(/=\s*A1/)).not.toBeInTheDocument();
    expect(screen.queryByText("A1")).not.toBeInTheDocument();
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
    setupMocks(); // REVIEW_STATE has no rule_events key at all
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

  it("renders the blind-mode banner when blind, and never renders it otherwise", async () => {
    setupMocks();
    const { unmount } = renderPane({ blind: true });
    await waitFor(() => {
      expect(screen.getByText(/BLIND MODE/)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/agent output hidden; your answers become the gold standard/),
    ).toBeInTheDocument();
    unmount();

    renderPane({ blind: false });
    await waitFor(() => {
      expect(screen.getByText("ACT score band")).toBeInTheDocument();
    });
    expect(screen.queryByText(/BLIND MODE/)).not.toBeInTheDocument();
  });
});
