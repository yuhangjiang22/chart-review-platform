import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAnswerInRange, assertNumericAnswerCited, canonicalizeNumericAnswer, canonicalizeStringAnswer } from "./review-state.js";

const moca = { id: "moca_score", answer_schema: { type: "integer", minimum: 0, maximum: 30 } };
const note = (q: string) => [{ source: "note", verbatim_quote: q }];

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

describe("assertNumericAnswerCited", () => {
  it("accepts a numeric answer whose value appears in a cited note quote", () => {
    expect(() => assertNumericAnswerCited(moca, 22, note("MoCA 22/30, mild impairment"))).not.toThrow();
    expect(() => assertNumericAnswerCited(moca, "22", note("Montreal Cognitive Assessment: 22"))).not.toThrow();
    const ppd = { id: "pack_per_day", answer_schema: { type: "number", minimum: 0, maximum: 20 } };
    expect(() => assertNumericAnswerCited(ppd, 0.5, note("0.5 ppd for 30 years"))).not.toThrow();
  });
  it("REJECTS a number not present in any cited quote (the 0-default bug)", () => {
    expect(() => assertNumericAnswerCited(moca, 0, note("no cognitive testing performed this visit"))).toThrow(/numeric_not_cited|no cited note quote/);
    expect(() => assertNumericAnswerCited(moca, 0, [])).toThrow();
    expect(() => assertNumericAnswerCited(moca, 22, note("MMSE 28/30"))).toThrow(); // wrong number cited
  });
  it("does not match a digit embedded in a larger number", () => {
    // answer 2 must NOT be considered grounded by '2026' or '22'
    expect(() => assertNumericAnswerCited(moca, 2, note("seen on 2026-01-02 visit, score 22"))).toThrow();
    expect(() => assertNumericAnswerCited(moca, 2, note("scored 2 of 30"))).not.toThrow();
  });
  it("skips null/empty (the legitimate 'not documented' path)", () => {
    expect(() => assertNumericAnswerCited(moca, null, undefined)).not.toThrow();
    expect(() => assertNumericAnswerCited(moca, "", note("anything"))).not.toThrow();
  });
  it("skips enum-coded staging and binary flags (0/negation is legitimate there)", () => {
    const cdr = { id: "cdr_global", answer_schema: { type: "number", enum: [0, 0.5, 1, 2, 3] } };
    const flag = { id: "impaired_cognition", answer_schema: { enum: ["1", "0"] } };
    expect(() => assertNumericAnswerCited(cdr, 0, note("no dementia rating documented"))).not.toThrow();
    expect(() => assertNumericAnswerCited(flag, "0", note("denies memory complaints"))).not.toThrow();
  });
  it("ignores omop evidence — only note quotes can ground a numeric scale", () => {
    expect(() => assertNumericAnswerCited(moca, 22, [{ source: "omop", verbatim_quote: "22" } as never])).toThrow();
  });
  it("exempts numeric_grounding:structured fields (value computed from structured data)", () => {
    // onset_latency_days = -start_day, computed from get_drug_episodes; the
    // number legitimately never appears verbatim in a note quote, so the
    // note-grounding requirement must NOT apply to it.
    const latency = { id: "onset_latency_days", answer_schema: { type: "integer", minimum: 0, maximum: 3650 }, numeric_grounding: "structured" };
    expect(() => assertNumericAnswerCited(latency, 126, note("started lisinopril; developed jaundice"))).not.toThrow();
    expect(() => assertNumericAnswerCited(latency, 126, [])).not.toThrow();
    expect(() => assertNumericAnswerCited(latency, 0, undefined)).not.toThrow();
    // the exemption is opt-in: a plain documented scale still requires the digit.
    expect(() => assertNumericAnswerCited(moca, 126, note("no MoCA this visit"))).toThrow();
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

describe("canonicalizeStringAnswer", () => {
  const quit = { answer_schema: { type: "string" } };
  it("stringifies a numeric-looking free-text answer (quit year 2008 → '2008')", () => {
    expect(canonicalizeStringAnswer(quit, 2008)).toBe("2008");
    expect(typeof canonicalizeStringAnswer(quit, 2008)).toBe("string");
    expect(canonicalizeStringAnswer(quit, "age 55")).toBe("age 55");
  });
  it("leaves non-string fields / null untouched", () => {
    expect(canonicalizeStringAnswer(moca, 21)).toBe(21);
    expect(canonicalizeStringAnswer(quit, null)).toBeNull();
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
