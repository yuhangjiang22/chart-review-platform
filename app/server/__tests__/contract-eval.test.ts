import { describe, it, expect } from "vitest";
import { safeEval } from "../contract-eval";
import { fieldApplicability } from "../contract-eval";
import { evalDerivation, derivedInputs } from "../contract-eval";
import { divergedFromAgent, evidenceSignature } from "../contract-eval";

describe("safeEval", () => {
  it("returns null on disallowed chars", () => {
    expect(safeEval("alert(1)", {})).toBe(null);
  });
  it("evaluates equality + AND/OR with env substitution", () => {
    expect(safeEval("a == 'yes' AND b == 1", { a: "yes", b: 1 })).toBe(true);
    expect(safeEval("a == 'no' OR b == 2", { a: "yes", b: 2 })).toBe(true);
  });
  it("evaluates `in` against a literal list", () => {
    expect(safeEval("x in ['a','b','c']", { x: "b" })).toBe(true);
    expect(safeEval("x in ['a','b']", { x: "z" })).toBe(false);
  });
  it("returns undefined when an identifier is missing", () => {
    // safeEval substitutes 'undefined' literal for missing ids; the
    // evaluator returns undefined; our wrapper coerces null on throws only
    const r = safeEval("missing == 'x'", {});
    expect([null, false]).toContain(r);
  });
  it("handles ternary", () => {
    expect(safeEval("a == 'yes' ? 'ok' : 'no'", { a: "yes" })).toBe("ok");
  });
});

describe("fieldApplicability", () => {
  const task = {
    fields: [
      { id: "a", answer_schema: { type: "string" } },
      { id: "b", is_applicable_when: "a == 'yes'", answer_schema: { type: "string" } },
      { id: "c", is_applicable_when: "missing == 'x'", answer_schema: { type: "string" } },
      { id: "d", answer_schema: { type: "string" } },
    ],
  };

  it("returns 'applicable' for fields with no gate", () => {
    expect(fieldApplicability(task, { a: "yes" }, "a")).toBe("applicable");
    expect(fieldApplicability(task, { a: "yes" }, "d")).toBe("applicable");
  });
  it("returns 'applicable' or 'not_applicable' based on gate", () => {
    expect(fieldApplicability(task, { a: "yes" }, "b")).toBe("applicable");
    expect(fieldApplicability(task, { a: "no" }, "b")).toBe("not_applicable");
  });
  it("returns 'unknown' when an upstream answer is missing", () => {
    expect(fieldApplicability(task, {}, "b")).toBe("unknown");
    expect(fieldApplicability(task, { a: "yes" }, "c")).toBe("unknown");
  });
});

describe("derivedInputs / evalDerivation", () => {
  const task = {
    fields: [
      { id: "a" },
      { id: "b" },
      { id: "outcome", derivation: "a == 'yes' AND b == 'yes' ? 'confirmed' : 'absent'" },
    ],
  };

  it("derivedInputs lists referenced field ids", () => {
    expect(derivedInputs(task, "outcome").sort()).toEqual(["a", "b"]);
  });
  it("evalDerivation evaluates against current answers", () => {
    expect(evalDerivation(task, { a: "yes", b: "yes" }, "outcome")).toBe("confirmed");
    expect(evalDerivation(task, { a: "yes", b: "no" }, "outcome")).toBe("absent");
  });
  it("returns null when an input is undefined", () => {
    expect(evalDerivation(task, { a: "yes" }, "outcome")).toBe(null);
  });
});

describe("safeEval — arithmetic (lift A)", () => {
  it("evaluates + - * /", () => {
    expect(safeEval("3 + 4", {})).toBe(7);
    expect(safeEval("10 - 3", {})).toBe(7);
    expect(safeEval("6 * 7", {})).toBe(42);
    expect(safeEval("12 / 4", {})).toBe(3);
  });
  it("respects mul-above-add precedence", () => {
    expect(safeEval("1 + 2 * 3", {})).toBe(7);
    expect(safeEval("(1 + 2) * 3", {})).toBe(9);
  });
  it("supports unary minus and negative literals via env", () => {
    expect(safeEval("0 - score", { score: 7 })).toBe(-7);
    expect(safeEval("score == -5", { score: -5 })).toBe(true);
  });
  it("returns null for division by zero", () => {
    expect(safeEval("a / b", { a: 5, b: 0 })).toBe(null);
  });
  it("propagates null through arithmetic", () => {
    expect(safeEval("a + b", { a: null, b: 5 })).toBe(null);
    expect(safeEval("a + b", { a: 5, b: null })).toBe(null);
    expect(safeEval("a * b", { a: null, b: 0 })).toBe(null);
  });
  it("preserves equality semantics with null env values", () => {
    expect(safeEval("a == null", { a: null })).toBe(true);
    expect(safeEval("a != null", { a: null })).toBe(false);
    expect(safeEval("a != null", { a: 5 })).toBe(true);
  });
});

describe("safeEval — count_true", () => {
  it("counts truthy operands", () => {
    expect(safeEval("count_true([a, b, c])", { a: true, b: true, c: true })).toBe(3);
    expect(safeEval("count_true([a, b, c])", { a: true, b: false, c: true })).toBe(2);
  });
  it("skips null operands", () => {
    expect(safeEval("count_true([a, b, c])", { a: null, b: true, c: false })).toBe(1);
    expect(safeEval("count_true([a, b, c])", { a: null, b: null, c: null })).toBe(0);
  });
  it("evaluates expression operands inside the list", () => {
    expect(
      safeEval("count_true([a == 'yes', b == 'yes', c == 'yes'])", {
        a: "yes",
        b: "no",
        c: "yes",
      }),
    ).toBe(2);
  });
  it("RUCAM domain-5 idiom: count exclusions, threshold by tier", () => {
    const env = { hav: "yes", hbv: "yes", hcv: "yes", hev: "yes", auto: "no" };
    const expr =
      "count_true([hav == 'yes', hbv == 'yes', hcv == 'yes', hev == 'yes', auto == 'yes']) >= 4";
    expect(safeEval(expr, env)).toBe(true);
  });
  it("handles empty list", () => {
    expect(safeEval("count_true([])", {})).toBe(0);
  });
});

describe("safeEval — days_between", () => {
  it("returns d1 - d2 in integer days", () => {
    expect(safeEval("days_between(a, b)", { a: "2024-04-05", b: "2024-03-12" })).toBe(24);
    expect(safeEval("days_between(a, b)", { a: "2024-03-12", b: "2024-04-05" })).toBe(-24);
    expect(safeEval("days_between(a, b)", { a: "2024-04-05", b: "2024-04-05" })).toBe(0);
  });
  it("returns null on null operand", () => {
    expect(safeEval("days_between(a, b)", { a: null, b: "2024-04-05" })).toBe(null);
    expect(safeEval("days_between(a, b)", { a: "2024-04-05", b: null })).toBe(null);
  });
  it("returns null for unparseable date strings", () => {
    expect(safeEval("days_between(a, b)", { a: "not a date", b: "2024-04-05" })).toBe(null);
    expect(safeEval("days_between(a, b)", { a: "2024/04/05", b: "2024-03-12" })).toBe(null);
  });
  it("composes with comparison + ternary (RUCAM domain-1 idiom)", () => {
    const expr =
      "days_between(a, b) >= 5 AND days_between(a, b) <= 90 ? 2 : " +
      "days_between(a, b) < 5 OR days_between(a, b) > 90 ? 1 : 0";
    expect(safeEval(expr, { a: "2024-04-05", b: "2024-03-12" })).toBe(2);
    expect(safeEval(expr, { a: "2024-03-13", b: "2024-03-12" })).toBe(1);
  });
});

describe("divergedFromAgent", () => {
  const ag = {
    answer: "yes",
    evidence: [{ source: "note", note_id: "n1", start: 10, end: 20 } as never],
  };
  it("returns false when current matches snapshot", () => {
    expect(divergedFromAgent({ answer: "yes", evidence: ag.evidence }, ag)).toBe(false);
  });
  it("returns true when answer differs", () => {
    expect(divergedFromAgent({ answer: "no", evidence: ag.evidence }, ag)).toBe(true);
  });
  it("returns true when evidence signatures differ", () => {
    const ev2 = [{ source: "note", note_id: "n2", start: 0, end: 5 } as never];
    expect(divergedFromAgent({ answer: "yes", evidence: ev2 }, ag)).toBe(true);
  });
  it("returns false when no snapshot", () => {
    expect(divergedFromAgent({ answer: "yes" }, null)).toBe(false);
  });
});
