import { describe, it, expect } from "vitest";
import { deriveNerReviewStatus, deriveAdherenceReviewStatus } from "./review-completion.js";

// Regression guard for the bug: validating per-unit (notes / questions / rules)
// must flip the top-level review_status so the patient shows validated OUTSIDE
// the review pane (SessionSidebar oracle_done, GET /api/patients, performance,
// export gold all key on review_status === "reviewer_validated"). A mocked
// component test can't catch this — it asserts the POST fires, not that the
// outside-visible status changes. These exercise the actual derivation the
// validation routes apply.

describe("deriveNerReviewStatus", () => {
  const spans3 = [
    { note_id: "n1" }, { note_id: "n1" }, { note_id: "n2" }, { note_id: "n3" },
  ];
  it("all notes-with-spans validated → reviewer_validated", () => {
    expect(deriveNerReviewStatus({ span_labels: spans3, validated_notes: ["n1", "n2", "n3"] }))
      .toBe("reviewer_validated");
  });
  it("some notes validated → in_progress", () => {
    expect(deriveNerReviewStatus({ span_labels: spans3, validated_notes: ["n1"] }))
      .toBe("in_progress");
  });
  it("no notes validated → undefined (leave as drafted)", () => {
    expect(deriveNerReviewStatus({ span_labels: spans3, validated_notes: [] })).toBeUndefined();
    expect(deriveNerReviewStatus({ span_labels: spans3 })).toBeUndefined();
  });
  it("extra validated notes beyond the span set still completes", () => {
    expect(deriveNerReviewStatus({ span_labels: [{ note_id: "n1" }], validated_notes: ["n1", "n9"] }))
      .toBe("reviewer_validated");
  });
  it("zero spans → undefined (nothing to validate)", () => {
    expect(deriveNerReviewStatus({ span_labels: [], validated_notes: [] })).toBeUndefined();
  });
});

describe("deriveAdherenceReviewStatus", () => {
  const fw = { questionIds: ["q1", "q2"], ruleIds: ["r1"] };
  it("all questions AND rules validated → reviewer_validated", () => {
    expect(deriveAdherenceReviewStatus(
      { validated_questions: ["q1", "q2"], validated_rules: ["r1"] }, fw,
    )).toBe("reviewer_validated");
  });
  it("questions done but a rule pending → in_progress", () => {
    expect(deriveAdherenceReviewStatus(
      { validated_questions: ["q1", "q2"], validated_rules: [] }, fw,
    )).toBe("in_progress");
  });
  it("partial questions → in_progress", () => {
    expect(deriveAdherenceReviewStatus({ validated_questions: ["q1"], validated_rules: ["r1"] }, fw))
      .toBe("in_progress");
  });
  it("nothing validated → undefined", () => {
    expect(deriveAdherenceReviewStatus({}, fw)).toBeUndefined();
  });
  it("a framework with no rules completes on questions alone", () => {
    expect(deriveAdherenceReviewStatus(
      { validated_questions: ["q1", "q2"] }, { questionIds: ["q1", "q2"], ruleIds: [] },
    )).toBe("reviewer_validated");
  });

  // Events axis (spec 2026-08-24 Task 5 review, Important 5): a blind
  // gold-collection session answers ONLY events, never touching
  // validated_questions/validated_rules — without this axis it could never
  // reach reviewer_validated, which also means App.tsx's anti-clobber
  // "never re-import over an already-validated patient" guard would never
  // engage for it.
  const anchoredEvents = [
    { event_id: "ev1", anchor: { type: "encounter", date: "2025-01-01" } },
    { event_id: "ev2", anchor: { type: "encounter", date: "2025-02-01" } },
  ];
  it("all anchored events validated (+ questions/rules validated) → reviewer_validated", () => {
    expect(deriveAdherenceReviewStatus(
      {
        validated_questions: ["q1", "q2"],
        validated_rules: ["r1"],
        rule_events: anchoredEvents,
        validated_events: ["ev1", "ev2"],
      },
      fw,
    )).toBe("reviewer_validated");
  });
  it("PINS THE TIGHTENING: a non-blind session with ALL questions+rules validated but one anchored event still unvalidated does NOT reach reviewer_validated (Task 5 re-review, Important 2)", () => {
    expect(deriveAdherenceReviewStatus(
      {
        validated_questions: ["q1", "q2"],
        validated_rules: ["r1"],
        rule_events: anchoredEvents,
        validated_events: ["ev1"],
      },
      fw,
    )).toBe("in_progress");
  });
  it("a state with NO anchored events (rule_events absent, or window-only) completes on questions+rules alone — the events axis doesn't block legacy/period-only states", () => {
    expect(deriveAdherenceReviewStatus(
      { validated_questions: ["q1", "q2"], validated_rules: ["r1"] }, fw,
    )).toBe("reviewer_validated");
    expect(deriveAdherenceReviewStatus(
      {
        validated_questions: ["q1", "q2"],
        validated_rules: ["r1"],
        rule_events: [{ event_id: "r1@window", anchor: { type: "window" } }], // no date → not anchored
        validated_events: [],
      },
      fw,
    )).toBe("reviewer_validated");
  });
  // NOTE: the first draft of this test passed {questionIds: [], ruleIds: []}
  // — an EMPTY framework — which made it vacuous: the original (pre-fix)
  // three-axis check ALSO returns reviewer_validated for an empty framework
  // (questionsDone/rulesDone are trivially true when there's nothing to
  // validate), so the test passed even before the events-only completion
  // path existed. Every real call site (adherence-routes.ts, ×4) builds
  // `framework` from loadAdherenceSkill's REAL question/rule ids, which are
  // never empty for asthma-adherence — so this now uses `fw` (non-empty),
  // matching production, to actually exercise the new path (Task 5
  // re-review, Important 2).
  it("a BLIND gold session answering ONLY events (no validated_questions/validated_rules at all, REAL non-empty framework) still reaches reviewer_validated once every anchored event is validated", () => {
    expect(deriveAdherenceReviewStatus(
      { rule_events: anchoredEvents, validated_events: ["ev1", "ev2"] },
      fw,
    )).toBe("reviewer_validated");
  });
  it("only some events validated, nothing else touched, REAL non-empty framework → in_progress (not undefined)", () => {
    expect(deriveAdherenceReviewStatus(
      { rule_events: anchoredEvents, validated_events: ["ev1"] },
      fw,
    )).toBe("in_progress");
  });
});
