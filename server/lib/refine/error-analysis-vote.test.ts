// Unit tests for the repeat-vote majority rule that tames single-vote
// attribution variance (server/lib/refine/error-analysis.ts).
//
// The rule: the refinable-vs-slip decision is by MAJORITY (gap+ambiguity vs
// slip); the refinable subtype is the more-voted of gap/ambiguity (tie →
// rubric_gap). A borderline cell only refines when most votes say so; a clear
// model error needs a slip majority to be left alone.
import { describe, it, expect } from "vitest";
import { pickMajorityErrorClass, type ErrorClass } from "./error-analysis.js";

const C = (gap: number, amb: number, slip: number): ErrorClass[] => [
  ...Array<ErrorClass>(gap).fill("rubric_gap"),
  ...Array<ErrorClass>(amb).fill("genuine_ambiguity"),
  ...Array<ErrorClass>(slip).fill("model_slip"),
];

describe("pickMajorityErrorClass", () => {
  it("a clear slip majority is left alone (not refined)", () => {
    expect(pickMajorityErrorClass(C(0, 0, 5)).winner).toBe("model_slip");
    expect(pickMajorityErrorClass(C(1, 0, 4)).winner).toBe("model_slip");
  });

  it("the borderline 3-2 ambiguity case refines (the cell single-vote flips)", () => {
    // This is exactly adenosq_02 in the test: 3 ambiguity, 2 slip → refinable.
    expect(pickMajorityErrorClass(C(0, 3, 2)).winner).toBe("genuine_ambiguity");
  });

  it("gap + ambiguity combine to beat slip (binary refinable decision)", () => {
    // 2 gap + 1 ambiguity vs 2 slip → refinable wins 3-2; subtype = gap (more votes).
    expect(pickMajorityErrorClass(C(2, 1, 2)).winner).toBe("rubric_gap");
    // 1 gap + 2 ambiguity vs 2 slip → refinable wins; subtype = ambiguity.
    expect(pickMajorityErrorClass(C(1, 2, 2)).winner).toBe("genuine_ambiguity");
  });

  it("refinable must STRICTLY beat slip — an even split stays model_slip", () => {
    // 1 gap + 1 ambiguity (2 refinable) vs 2 slip → not strictly greater → slip.
    expect(pickMajorityErrorClass(C(1, 1, 2)).winner).toBe("model_slip");
  });

  it("gap/ambiguity tie within a refinable win breaks to rubric_gap", () => {
    expect(pickMajorityErrorClass(C(2, 2, 1)).winner).toBe("rubric_gap");
  });

  it("returns the exact per-class tally for transparency", () => {
    expect(pickMajorityErrorClass(C(1, 3, 1)).tally).toEqual({
      rubric_gap: 1,
      genuine_ambiguity: 3,
      model_slip: 1,
    });
  });

  it("a unanimous single vote works (votes=1 disables voting)", () => {
    expect(pickMajorityErrorClass(["genuine_ambiguity"]).winner).toBe("genuine_ambiguity");
    expect(pickMajorityErrorClass(["model_slip"]).winner).toBe("model_slip");
  });
});
