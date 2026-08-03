import { describe, it, expect } from "vitest";
import { evalDerivation, safeEval } from "./contractEvalClient";

// Regression: APOE genotype values contain a slash ("e3/e4"). The client
// safeEval char-gate must allow "/" (parity with server contract-eval) or the
// whole derivation is rejected → derived field wrongly shows "waiting for
// inputs" even though the genotype IS answered.
const A2 = 'apoe_genotype in ["e2/e2","e2/e3","e2/e4","e2_carrier"] ? "1" : apoe_genotype in ["e3/e3","e3/e4","e4/e4"] ? "0" : "NA"';
const A4 = 'apoe_genotype in ["e2/e4","e3/e4","e4/e4","e4_carrier"] ? "1" : apoe_genotype in ["e2/e2","e2/e3","e3/e3"] ? "0" : "NA"';
const task = {
  fields: [{ id: "apoe_genotype" }, { id: "apoe2", derivation: A2 }, { id: "apoe4", derivation: A4 }],
};

describe("contractEvalClient — slash-containing string literals (APOE genotype)", () => {
  it("safeEval does not reject an expression with '/' in string literals", () => {
    expect(safeEval(A4, { apoe_genotype: "e3/e4" })).toBe("1");
  });
  it("derives alleles from a full genotype", () => {
    expect(evalDerivation(task, { apoe_genotype: "e3/e4" }, "apoe2")).toBe("0");
    expect(evalDerivation(task, { apoe_genotype: "e3/e4" }, "apoe4")).toBe("1");
  });
  it("handles single-allele carrier + no-genotype (NA)", () => {
    expect(evalDerivation(task, { apoe_genotype: "e4_carrier" }, "apoe2")).toBe("NA");
    expect(evalDerivation(task, { apoe_genotype: "e4_carrier" }, "apoe4")).toBe("1");
    expect(evalDerivation(task, { apoe_genotype: "none" }, "apoe4")).toBe("NA");
  });
});
