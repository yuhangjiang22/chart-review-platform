import { describe, it, expect } from "vitest";
import type { FieldAssessment } from "../domain/review/review-state.js";

describe("FieldAssessment.comment", () => {
  it("accepts a free-text comment and is optional", () => {
    const withComment: FieldAssessment = {
      field_id: "C1",
      source: "reviewer",
      status: "approved",
      updated_at: new Date().toISOString(),
      updated_by: "u1",
      comment: "Both agents missed the encounter date — note 7 has it.",
    };
    const without: FieldAssessment = {
      field_id: "C1",
      source: "reviewer",
      status: "approved",
      updated_at: new Date().toISOString(),
      updated_by: "u1",
    };
    expect(withComment.comment).toBe("Both agents missed the encounter date — note 7 has it.");
    expect(without.comment).toBeUndefined();
  });
});
