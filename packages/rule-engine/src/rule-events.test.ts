import { describe, it, expect } from "vitest";
import type { QuestionAnswer, RuleEvent } from "@chart-review/platform-types";
import {
  evaluateAllRules,
  evaluateAllRuleEvents,
  type RuleDefinition,
} from "./index.js";

const qa = (id: string, answer: QuestionAnswer["answer"]): QuestionAnswer =>
  ({ question_id: id, tier: 1, answer });

const ev = (
  ruleId: string, id: string, over: Partial<RuleEvent> = {},
): RuleEvent => ({
  event_id: id,
  rule_id: ruleId,
  anchor: { type: "encounter", date: "2024-11-14", origin: "omop", ref: "encounters:18" },
  ...over,
});

const STEP_RULE: RuleDefinition = {
  rule_id: "R-Step",
  description: "regimen matches step at each visit with a control picture",
  event_anchor: "visits",
  event_evaluable_if: 'ControlLevel is present',
  verdict_if: 'StepMatch == "matches"',
  excluded_if: 'StepMatch == "unknown"',
  attribution: "DOCUMENTATION_GAP",
};

const WINDOW_RULE: RuleDefinition = {
  rule_id: "R-Spiro",
  description: "spirometry in window",
  verdict_if: "SpiroDate is present",
  attribution: "DOCUMENTATION_GAP",
};

describe("evaluateAllRuleEvents", () => {
  it("evaluates each event on its own merged answers and rolls up rate + worst-case", () => {
    const patient = [qa("SpiroDate", null)];
    const events = [
      ev("R-Step", "R-Step@2024-02-01@e1", { answers: [qa("ControlLevel", "well_controlled"), qa("StepMatch", "matches")] }),
      ev("R-Step", "R-Step@2024-11-14@e2", { answers: [qa("ControlLevel", "not_well_controlled"), qa("StepMatch", "under_treated")] }),
      ev("R-Step", "R-Step@2024-12-02@e3", { answers: [qa("ControlLevel", "not_well_controlled"), qa("StepMatch", "matches")] }),
    ];
    const out = evaluateAllRuleEvents([STEP_RULE, WINDOW_RULE], patient, events);

    const step = out.rule_rollups.find((r) => r.rule_id === "R-Step")!;
    expect(step.n_evaluable).toBe(3);
    expect(step.n_concordant).toBe(2);
    expect(step.rate).toBeCloseTo(2 / 3);
    expect(step.period_verdict).toBe("NON_CONCORDANT");
    expect(step.period_attribution).toBe("DOCUMENTATION_GAP");

    const verdicts = out.rule_events.filter((e) => e.rule_id === "R-Step").map((e) => e.verdict);
    expect(verdicts).toEqual(["CONCORDANT", "NON_CONCORDANT", "CONCORDANT"]);
  });

  it("a rule without event_anchor gets one window event evaluated over patient answers", () => {
    const patient = [qa("SpiroDate", "2024-03-01")];
    const out = evaluateAllRuleEvents([WINDOW_RULE], patient, []);
    expect(out.rule_events).toHaveLength(1);
    expect(out.rule_events[0].event_id).toBe("R-Spiro@window");
    expect(out.rule_events[0].anchor.type).toBe("window");
    expect(out.rule_rollups[0].period_verdict).toBe("CONCORDANT");
    expect(out.rule_rollups[0].rate).toBe(1);
  });

  it("mirrored rule_verdicts match evaluateAllRules for anchor-free rules (ts excluded)", async () => {
    const patient = [qa("SpiroDate", null)];
    const legacy = (await evaluateAllRules([WINDOW_RULE], patient)).map(
      ({ ts: _ts, ...rest }) => rest,
    );
    const next = evaluateAllRuleEvents([WINDOW_RULE], patient, []).rule_verdicts.map(
      ({ ts: _ts, ...rest }) => rest,
    );
    expect(next).toEqual(legacy);
  });

  it("event_evaluable_if=false and agent evaluable:false events are excluded from the denominator", () => {
    const events = [
      ev("R-Step", "R-Step@2024-02-01@e1", { answers: [qa("StepMatch", "matches")] }), // no ControlLevel → not evaluable
      ev("R-Step", "R-Step@2024-11-14@e2", { evaluable: false, evaluable_reason: "transfer note only" }),
      ev("R-Step", "R-Step@2024-12-02@e3", { answers: [qa("ControlLevel", "not_well_controlled"), qa("StepMatch", "matches")] }),
    ];
    const out = evaluateAllRuleEvents([STEP_RULE], [], events);
    const roll = out.rule_rollups[0];
    expect(roll.n_events).toBe(3);
    expect(roll.n_evaluable).toBe(1);
    expect(roll.rate).toBe(1);
    expect(roll.period_verdict).toBe("CONCORDANT");
    expect(out.rule_events[0].evaluable).toBe(false);
  });

  it("zero evaluable events → period EXCLUDED, rate null", () => {
    const out = evaluateAllRuleEvents(
      [STEP_RULE],
      [],
      [ev("R-Step", "R-Step@2024-02-01@e1", { evaluable: false, evaluable_reason: "no data" })],
    );
    expect(out.rule_rollups[0].period_verdict).toBe("EXCLUDED");
    expect(out.rule_rollups[0].rate).toBeNull();
  });

  it("the synthetic _anchor_type answer is visible to event_evaluable_if", () => {
    const rule: RuleDefinition = {
      ...STEP_RULE,
      rule_id: "R-Followup",
      event_evaluable_if: '_anchor_type == "ocs_burst" or ControlLevel != "well_controlled"',
      verdict_if: "FollowupScheduled == true",
    };
    const burst: RuleEvent = {
      event_id: "R-Followup@2024-11-14@b1",
      rule_id: "R-Followup",
      anchor: { type: "ocs_burst", date: "2024-11-14", origin: "omop", ref: "drugs:9" },
      answers: [qa("FollowupScheduled", false)],
    };
    const out = evaluateAllRuleEvents([rule], [], [burst]);
    expect(out.rule_events[0].verdict).toBe("NON_CONCORDANT");
  });
});
