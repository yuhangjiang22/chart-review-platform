import { describe, it, expect } from "vitest";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import { evaluateAllRuleEvents, windowEventStub } from "./index.js";
import type { QuestionAnswer } from "@chart-review/platform-types";

// The cohort admits a patient at 365 days of prior observation; the spirometry
// question looks back 730. For a patient in between, "no spirometry found" may
// mean it was done before the extract begins — so judging it reports an artifact
// of the extract window as a documentation gap. cohort.sql emits
// `days_observed_before_index` for exactly this, and the ETL dropped the field
// before meta.json, so its own documented mitigation never ran.
//
// Asymmetric, like the follow-up rule's unobserved tail: a documented spirometry
// settles the event however short the chart is; only the negative is inconclusive.

const skill = loadAdherenceSkill("asthma-adherence");
const rule = skill.rules.filter((r) => r.rule_id === "R-T1-SpirometryWithin24mo");

const qa = (id: string, answer: QuestionAnswer["answer"]): QuestionAnswer =>
  ({ question_id: id, tier: 1, answer, source: "agent" });

const judge = (answers: QuestionAnswer[]) =>
  evaluateAllRuleEvents(rule, answers, [windowEventStub("R-T1-SpirometryWithin24mo")])
    .rule_events[0]!;

describe("a chart too short to hold the answer is not a care gap", () => {
  it("short chart + no spirometry -> censored, not NON_CONCORDANT", () => {
    const e = judge([qa("T1-SpirometryDate", null), qa("_days_observed_before_index", 400)]);
    expect(e.evaluable).toBe(false);
    expect(e.evaluable_reason).toContain("runs past the start of observation");
    expect(e.verdict).toBeUndefined();
  });

  it("short chart + spirometry DOCUMENTED still counts — the positive is conclusive", () => {
    const e = judge([qa("T1-SpirometryDate", "2025-03-04"), qa("_days_observed_before_index", 400)]);
    expect(e.evaluable).not.toBe(false);
    expect(e.verdict).toBe("CONCORDANT");
  });

  it("long chart + no spirometry is still the documentation gap it always was", () => {
    const e = judge([qa("T1-SpirometryDate", null), qa("_days_observed_before_index", 900)]);
    expect(e.evaluable).not.toBe(false);
    expect(e.verdict).toBe("NON_CONCORDANT");
    expect(e.attribution).toBe("DOCUMENTATION_GAP");
  });

  it("exactly 730 days is long enough — the boundary is not off by one", () => {
    const e = judge([qa("T1-SpirometryDate", null), qa("_days_observed_before_index", 730)]);
    expect(e.verdict).toBe("NON_CONCORDANT");
  });

  it("an extract with no observation length censors NOTHING", () => {
    // Absent information is not evidence that the chart is short; a comparison
    // against a missing answer is false. Every patient extracted before the field
    // existed keeps its previous behaviour.
    const e = judge([qa("T1-SpirometryDate", null)]);
    expect(e.evaluable).not.toBe(false);
    expect(e.verdict).toBe("NON_CONCORDANT");
  });

  it("the censored patient leaves the denominator rather than scoring 0", () => {
    const out = evaluateAllRuleEvents(
      rule,
      [qa("T1-SpirometryDate", null), qa("_days_observed_before_index", 400)],
      [windowEventStub("R-T1-SpirometryWithin24mo")],
    );
    const roll = out.rule_rollups[0]!;
    expect(roll.n_evaluable).toBe(0);
    expect(roll.rate).toBeNull();
    expect(roll.period_verdict).toBe("EXCLUDED");
  });
});
