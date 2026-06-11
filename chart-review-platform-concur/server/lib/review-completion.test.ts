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
});
