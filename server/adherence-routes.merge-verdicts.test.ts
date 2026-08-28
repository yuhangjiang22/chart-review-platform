import { describe, it, expect } from "vitest";
import { mergeRecomputedVerdicts } from "./adherence-routes.js";
import type { RuleVerdict } from "@chart-review/platform-types";

// Saving ONE event re-derives that rule plus every rule whose gate reads the
// derived worst control level, and the verdict list was spliced wholesale — so a
// verdict the reviewer had explicitly overridden was replaced by the engine's.
// Three things hid it: the row still read "✓ Accepted" (validated_rules is not
// touched), the readout was labelled "Engine:" for every verdict including a
// reviewer's, and the IAA route counts only source === "reviewer" verdicts, so the
// rule did not become a disagreement — it left the comparison and shrank the
// denominator.

const v = (rule_id: string, verdict: RuleVerdict["verdict"], source?: RuleVerdict["source"]): RuleVerdict =>
  ({ rule_id, verdict, ...(source ? { source } : {}) });

const byId = (list: RuleVerdict[]) =>
  Object.fromEntries(list.map((x) => [x.rule_id, `${x.verdict}/${x.source ?? "-"}`]));

describe("a reviewer's verdict survives a recomputation", () => {
  it("holds the reviewer's and takes the engine's for everything else", () => {
    const out = mergeRecomputedVerdicts(
      [v("R-Mine", "NON_CONCORDANT", "reviewer"), v("R-Auto", "CONCORDANT", "rule_engine")],
      [v("R-Mine", "CONCORDANT", "rule_engine"), v("R-Auto", "NON_CONCORDANT", "rule_engine")],
      new Set(["R-Mine", "R-Auto"]),
    );
    expect(byId(out)).toEqual({
      "R-Mine": "NON_CONCORDANT/reviewer",   // not replaced
      "R-Auto": "NON_CONCORDANT/rule_engine", // refreshed
    });
  });

  it("leaves rules outside the affected set completely alone", () => {
    const out = mergeRecomputedVerdicts(
      [v("R-Other", "EXCLUDED", "rule_engine")],
      [v("R-Edited", "CONCORDANT", "rule_engine")],
      new Set(["R-Edited"]),
    );
    expect(byId(out)).toEqual({
      "R-Other": "EXCLUDED/rule_engine",
      "R-Edited": "CONCORDANT/rule_engine",
    });
  });

  it("does not duplicate a rule when the reviewer holds it", () => {
    // The recomputed entry must be dropped, not appended beside the held one —
    // a duplicate rule_id would make every downstream reader's lookup order-dependent.
    const out = mergeRecomputedVerdicts(
      [v("R-Mine", "EXCLUDED", "reviewer")],
      [v("R-Mine", "CONCORDANT", "rule_engine")],
      new Set(["R-Mine"]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("reviewer");
  });

  it("an llm_judge verdict is NOT held — only a human's is", () => {
    const out = mergeRecomputedVerdicts(
      [v("R-Judged", "CONCORDANT", "llm_judge")],
      [v("R-Judged", "NON_CONCORDANT", "rule_engine")],
      new Set(["R-Judged"]),
    );
    expect(out[0]!.verdict).toBe("NON_CONCORDANT");
  });

  it("a reviewer verdict for a rule the recomputation dropped still survives", () => {
    const out = mergeRecomputedVerdicts(
      [v("R-Mine", "NON_CONCORDANT", "reviewer")], [], new Set(["R-Mine"]),
    );
    expect(byId(out)).toEqual({ "R-Mine": "NON_CONCORDANT/reviewer" });
  });

  it("keeps the same rule set — nothing is lost in either direction", () => {
    const stored = [v("A", "CONCORDANT", "reviewer"), v("B", "EXCLUDED", "rule_engine")];
    const out = mergeRecomputedVerdicts(
      stored, [v("A", "EXCLUDED", "rule_engine"), v("B", "CONCORDANT", "rule_engine")],
      new Set(["A", "B"]),
    );
    expect(out.map((x) => x.rule_id).sort()).toEqual(["A", "B"]);
  });
});
