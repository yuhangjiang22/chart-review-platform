import { describe, it, expect } from "vitest";
import { mergeRecomputedVerdicts, reconcileAdherenceImport } from "./adherence-merge.js";
import type { RuleEvent, RuleVerdict } from "@chart-review/platform-types";
import type { RuleDefinition } from "@chart-review/rule-engine";

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

// ── reconcileAdherenceImport ───────────────────────────────────────────────
// mergeAdherenceImport folds four arrays that must agree with each other, by
// three different rules. Each is defensible alone; together they can leave the
// derived arrays describing a different event set than the inputs.

const RULE: RuleDefinition = {
  rule_id: "R-Step", description: "regimen matches step at each visit",
  event_anchor: "visits",
  verdict_if: 'StepMatch == "matches"',
  attribution: "DOCUMENTATION_GAP",
  event_scoped_questions: ["StepMatch"],
};

const visit = (n: number, match: string, source?: "reviewer"): RuleEvent => ({
  event_id: `R-Step@2025-0${n}-01`, rule_id: "R-Step",
  anchor: { type: "visits", date: `2025-0${n}-01`, origin: "omop" },
  answers: [{ question_id: "StepMatch", tier: 2, answer: match, source: source ?? "agent" }],
  ...(source ? { source } : {}),
});

describe("reconcileAdherenceImport", () => {
  it("the rollup stops describing an event set that no longer exists", () => {
    // The live shape: the reviewer edited one event, so the merge KEPT that
    // rule's existing rollup — computed when the patient had 1 event — while its
    // events came from the new draft's work-list, which enumerates 3.
    const merged = {
      question_answers: [],
      rule_events: [visit(1, "matches", "reviewer"), visit(2, "under_treated"), visit(3, "matches")],
      rule_rollups: [{
        rule_id: "R-Step", n_events: 1, n_evaluable: 1, n_concordant: 1,
        n_non_concordant: 0, n_excluded: 0, rate: 1, period_verdict: "CONCORDANT" as const,
      }],
      rule_verdicts: [{ rule_id: "R-Step", verdict: "CONCORDANT" as const, source: "rule_engine" as const }],
    };
    const out = reconcileAdherenceImport(merged, [RULE]);
    const roll = out.rule_rollups![0]!;
    expect(roll.n_events).toBe(3);                       // was 1
    expect(roll.n_concordant).toBe(2);
    expect(roll.rate).toBeCloseTo(2 / 3);
    expect(roll.period_verdict).toBe("NON_CONCORDANT");  // one visit under-treated
    expect(out.rule_verdicts![0]!.verdict).toBe("NON_CONCORDANT"); // verdict agrees
  });

  it("keeps the reviewer's event answers AND their source, so the next import still wins", () => {
    const merged = {
      question_answers: [],
      rule_events: [visit(1, "matches", "reviewer"), visit(2, "matches")],
      rule_rollups: [], rule_verdicts: [],
    };
    const out = reconcileAdherenceImport(merged, [RULE]);
    const mine = out.rule_events!.find((e) => e.event_id === "R-Step@2025-01-01")!;
    expect(mine.source).toBe("reviewer");
    expect(mine.answers![0]!.answer).toBe("matches");
    expect(mine.verdict).toBe("CONCORDANT");   // and it got judged
  });

  it("a reviewer's rule verdict still stands after the recompute", () => {
    const merged = {
      question_answers: [],
      rule_events: [visit(1, "under_treated")],
      rule_rollups: [],
      rule_verdicts: [{ rule_id: "R-Step", verdict: "EXCLUDED" as const, source: "reviewer" as const }],
    };
    const out = reconcileAdherenceImport(merged, [RULE]);
    expect(out.rule_verdicts![0]!.verdict).toBe("EXCLUDED");
    expect(out.rule_verdicts![0]!.source).toBe("reviewer");
    // and the engine's own answer is still visible in the rollup
    expect(out.rule_rollups![0]!.period_verdict).toBe("NON_CONCORDANT");
  });

  it("does NOT recompute an eligibility-excluded patient", () => {
    // The runner blankets every rule EXCLUDED when the eligibility gate fails,
    // which a per-rule engine pass does not reproduce — recomputing would
    // silently un-exclude the patient.
    const merged = {
      adherence_excluded: true,
      question_answers: [],
      rule_events: [visit(1, "under_treated")],
      rule_rollups: [],
      rule_verdicts: [{ rule_id: "R-Step", verdict: "EXCLUDED" as const, source: "rule_engine" as const }],
    };
    const out = reconcileAdherenceImport(merged, [RULE]);
    expect(out.rule_verdicts![0]!.verdict).toBe("EXCLUDED");
    expect(out.rule_rollups).toEqual([]);
  });

  it("leaves a period-only draft alone — no events means no event-level information", () => {
    const merged = {
      question_answers: [{ question_id: "Q", tier: 1, answer: true }],
      rule_events: [], rule_rollups: [], rule_verdicts: [],
    };
    expect(reconcileAdherenceImport(merged, [RULE])).toEqual(merged);
  });
});
