import { describe, it, expect } from "vitest";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import { questionsReadBy, type RuleDefinition } from "./index.js";

// `supporting_questions` is a hand-written declaration; the pane renders it as
// the rule's "Inputs:" row. It drifted from what the engine reads on 4 of the 12
// v0.6 rules, in both directions:
//
//   read but NOT declared  — R-T2-StepTherapyMatches read T1-ControlLevel in its
//     applicability gate, so the input deciding whether the rule applied at all
//     was invisible to the reviewer. This direction is a defect and the invariant
//     below now forbids it.
//   declared but NOT read  — R-T1-ControllerForPersistent declared a control
//     level no expression read, which is how a whole missing rule arm hid in
//     plain sight (see controller-arms.test.ts). This direction is legitimate
//     when a rule delegates applicability to a question's own enum, so it is
//     REPORTED (the pane shows those separately) rather than banned.

const skill = loadAdherenceSkill("asthma-adherence");

describe("questionsReadBy", () => {
  it("collects from every expression a rule can carry", () => {
    const rule = {
      rule_id: "R-Probe", description: "probe",
      verdict_if: 'A == true',
      excluded_if: 'B == "x"',
      event_evaluable_if: 'C is present',
      event_censored_if: '_window_censored == true and D != true',
      attribution_when: [{ when: 'E == "y"', category: "PATIENT_FACTOR" }],
    } as unknown as RuleDefinition;
    // _window_censored is engine-supplied, not a question anybody answers.
    expect(questionsReadBy(rule)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("a malformed expression contributes nothing instead of throwing", () => {
    const rule = { rule_id: "R-Bad", description: "x", verdict_if: "(((" } as RuleDefinition;
    expect(questionsReadBy(rule)).toEqual([]);
  });
});

describe("every rule declares what it reads — asthma rubric", () => {
  for (const rule of skill.rules) {
    it(`${rule.rule_id}`, () => {
      const declared = new Set(rule.supporting_questions ?? []);
      const undeclared = questionsReadBy(rule).filter((q) => !declared.has(q));
      expect(undeclared, `reads but does not declare: ${undeclared.join(", ")}`).toEqual([]);
    });
  }
});
