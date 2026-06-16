import { describe, it, expect } from "vitest";
import { assertAnswerInEnum, ReviewStateError } from "./review-state.js";

const enumField = {
  id: "cancer_type",
  answer_schema: { enum: ["squamous_cell_carcinoma", "adenocarcinoma", "other", "no_info"] },
};
const freeTextField = { id: "summary", answer_schema: { type: "string" } };
const multiField = { id: "tags", answer_schema: { enum: ["a", "b", "c"] } };

describe("assertAnswerInEnum", () => {
  it("passes an answer that is in the enum", () => {
    expect(() => assertAnswerInEnum(enumField, "adenocarcinoma")).not.toThrow();
  });

  it("rejects off-enum free text with answer_not_in_enum + the allowed values + escape hatch", () => {
    try {
      assertAnswerInEnum(enumField, "adenosquamous carcinoma");
      throw new Error("expected assertAnswerInEnum to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewStateError);
      expect((e as ReviewStateError).code).toBe("answer_not_in_enum");
      expect((e as Error).message).toContain("adenocarcinoma");
      expect((e as Error).message).toMatch(/other.*no_info|"other"/);
    }
  });

  it("allows null / undefined / empty answer (cleared or not answered)", () => {
    expect(() => assertAnswerInEnum(enumField, null)).not.toThrow();
    expect(() => assertAnswerInEnum(enumField, undefined)).not.toThrow();
    expect(() => assertAnswerInEnum(enumField, "")).not.toThrow();
  });

  it("skips fields with no enum (free-text / numeric)", () => {
    expect(() => assertAnswerInEnum(freeTextField, "anything goes here")).not.toThrow();
  });

  it("trims surrounding whitespace before matching", () => {
    expect(() => assertAnswerInEnum(enumField, " adenocarcinoma ")).not.toThrow();
  });

  it("validates every element of a multi-value (cardinality many) answer", () => {
    expect(() => assertAnswerInEnum(multiField, ["a", "b"])).not.toThrow();
    expect(() => assertAnswerInEnum(multiField, ["a", "z"])).toThrow(/not an allowed value/);
  });
});
