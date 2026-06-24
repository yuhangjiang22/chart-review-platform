import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAnswerInRange, canonicalizeNumericAnswer } from "./review-state.js";

const moca = { id: "moca_score", answer_schema: { type: "integer", minimum: 0, maximum: 30 } };

describe("assertAnswerInRange", () => {
  it("accepts an in-range integer (incl. numeric string)", () => {
    expect(() => assertAnswerInRange(moca, 21)).not.toThrow();
    expect(() => assertAnswerInRange(moca, "21")).not.toThrow();
    expect(() => assertAnswerInRange(moca, 0)).not.toThrow();
  });
  it("rejects out-of-range, non-numeric, and non-integer", () => {
    expect(() => assertAnswerInRange(moca, 35)).toThrow();
    expect(() => assertAnswerInRange(moca, "abc")).toThrow();
    expect(() => assertAnswerInRange(moca, 21.5)).toThrow();
  });
  it("skips null / cleared", () => {
    expect(() => assertAnswerInRange(moca, null)).not.toThrow();
    expect(() => assertAnswerInRange(moca, "")).not.toThrow();
  });
  it("skips enum and free-text fields", () => {
    expect(() => assertAnswerInRange({ id: "x", answer_schema: { enum: ["1", "0"] } }, "anything")).not.toThrow();
    expect(() => assertAnswerInRange({ id: "lmp", answer_schema: { type: "string" } }, "05/10/2026")).not.toThrow();
  });
});

describe("canonicalizeNumericAnswer", () => {
  it("coerces a numeric string to a number", () => {
    expect(canonicalizeNumericAnswer(moca, "21")).toBe(21);
    expect(canonicalizeNumericAnswer(moca, 21)).toBe(21);
  });
  it("leaves free-text / null untouched", () => {
    expect(canonicalizeNumericAnswer({ answer_schema: { type: "string" } }, "05/10/2026")).toBe("05/10/2026");
    expect(canonicalizeNumericAnswer(moca, null)).toBeNull();
  });
});

const TASK = {
  task_id: "acts", task_kind: "phenotype" as const, source_document_sha: "x", fields: [moca],
};
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "num-gate-")); process.env.CHART_REVIEW_REVIEWS_ROOT = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_REVIEWS_ROOT; });

describe("applyUiAction with a numeric field", () => {
  it("stores a numeric answer AS A NUMBER and rejects out-of-range", async () => {
    const m = await import("./review-state.js");
    m.applyUiAction("p1", TASK as never, "reviewer", "r", {
      type: "set_field_assessment", payload: { field_id: "moca_score", answer: "21" },
    });
    const fa = m.load("p1", "acts")!.field_assessments.find((a) => a.field_id === "moca_score")!;
    expect(fa.answer).toBe(21);
    expect(typeof fa.answer).toBe("number");
    expect(() =>
      m.applyUiAction("p1", TASK as never, "reviewer", "r", {
        type: "set_field_assessment", payload: { field_id: "moca_score", answer: 99 },
      }),
    ).toThrow();
  });
});
