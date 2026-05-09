import { describe, it, expect } from "vitest";
import type { FieldAssessment } from "../domain/review/review-state.js";

describe("FieldAssessment.captured_against_schema_hash", () => {
  it("accepts the optional 16-char SHA prefix", () => {
    const fa: FieldAssessment = {
      field_id: "C1",
      source: "reviewer",
      status: "approved",
      updated_at: new Date().toISOString(),
      updated_by: "u1",
      captured_against_schema_hash: "abcd1234ef567890",
    };
    expect(fa.captured_against_schema_hash).toBe("abcd1234ef567890");
  });

  it("is optional (legacy records without the field remain valid)", () => {
    const fa: FieldAssessment = {
      field_id: "C1",
      source: "reviewer",
      status: "approved",
      updated_at: new Date().toISOString(),
      updated_by: "u1",
    };
    expect(fa.captured_against_schema_hash).toBeUndefined();
  });
});
