import { describe, it, expect } from "vitest";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import { evaluateAllRuleEvents } from "./index.js";
import type { RuleEvent } from "@chart-review/platform-types";

// Persistent asthma has two arms — ">= 2 exacerbations in a rolling year" OR "not
// well controlled" — and only the first was implemented. It lives in the ETL, as
// the single `obligation_points` anchor derived from exacerbations. The control
// arm could not go there: control level is a judgment made FROM THE NOTES, after
// enumeration (structured ACT is absent from this drop entirely), so no anchor
// list can carry it. A child not well controlled at every visit who never had two
// OCS courses therefore produced zero events, rolled up EXCLUDED, and dropped out
// of the study's most important measurement — a MISSED care gap, the opposite
// direction from every other defect in this audit.
//
// R-T1-ControllerAtUncontrolledVisit closes it with the shape the rubric already
// uses twice (R-T2-FollowupScheduled, R-T2-StepTherapyMatches): enumerate every
// asthma visit as a candidate, let the per-event control level decide.

const skill = loadAdherenceSkill("asthma-adherence");
const RULE_ID = "R-T1-ControllerAtUncontrolledVisit";
const rule = skill.rules.filter((r) => r.rule_id === RULE_ID);

const visit = (
  date: string, control: string | null, controller: boolean | null,
  contra?: string,
): RuleEvent => ({
  event_id: `${RULE_ID}@${date}`, rule_id: RULE_ID,
  anchor: { type: "asthma_encounters", date, origin: "omop" },
  answers: [
    ...(control === null ? [] : [{ question_id: "T1-ControlLevel", tier: 1, answer: control }]),
    { question_id: "T1-ControllerPrescribed", tier: 1, answer: controller },
    ...(contra ? [{ question_id: "T2-ContraindicationDocumented", tier: 2, answer: contra }] : []),
  ],
} as RuleEvent);

const judge = (e: RuleEvent) => evaluateAllRuleEvents(rule, [], [e]).rule_events[0]!;

describe("the rule exists and reads the visit's own control level", () => {
  it("is in the rubric, anchored on asthma visits", () => {
    expect(rule).toHaveLength(1);
    expect(rule[0]!.event_anchor).toBe("asthma_encounters");
  });

  it("both arms are present as SEPARATE rules with separate denominators", () => {
    // Deliberate: re-anchoring the exacerbation rule would change its denominator
    // from one obligation point per patient to one per visit, and reopen the
    // "by the deadline" grace semantics settled 2026-08-27. A patient with two
    // exacerbations AND uncontrolled visits is measured by both, as two different
    // requirements — so the two rates are reported per rule and never summed.
    const ids = skill.rules.map((r) => r.rule_id);
    expect(ids).toContain("R-T1-ControllerForPersistent");
    expect(ids).toContain(RULE_ID);
    const exacerbationArm = skill.rules.find((r) => r.rule_id === "R-T1-ControllerForPersistent")!;
    expect(exacerbationArm.event_anchor).toBe("obligation_points");
  });
});

describe("applicability comes from THAT visit", () => {
  it("a not-well-controlled visit with no controller is a documentation gap", () => {
    const e = judge(visit("2025-11-04", "not_well_controlled", false));
    expect(e.evaluable).not.toBe(false);
    expect(e.verdict).toBe("NON_CONCORDANT");
    expect(e.attribution).toBe("DOCUMENTATION_GAP");
  });

  it("a very-poorly-controlled visit WITH a controller is concordant", () => {
    expect(judge(visit("2025-11-04", "very_poorly_controlled", true)).verdict).toBe("CONCORDANT");
  });

  it("a well-controlled visit is not in the denominator at all", () => {
    const e = judge(visit("2025-11-15", "well_controlled", false));
    expect(e.evaluable).toBe(false);
    expect(e.verdict).toBeUndefined();
  });

  it("an undetermined control level is not judged either", () => {
    // "We could not tell whether this visit was uncontrolled" cannot establish
    // that a controller was owed. Same for a control level nobody answered.
    expect(judge(visit("2025-11-15", "undetermined", false)).evaluable).toBe(false);
    expect(judge(visit("2025-11-15", null, false)).evaluable).toBe(false);
  });

  it("one uncontrolled visit among controlled ones still reports a gap", () => {
    // The whole point of per-visit applicability: a patient who is fine at three
    // visits and uncontrolled at one is measured on the one.
    const out = evaluateAllRuleEvents(rule, [], [
      visit("2025-11-04", "not_well_controlled", false),
      visit("2025-11-15", "well_controlled", false),
      visit("2025-12-16", "well_controlled", true),
    ]);
    const roll = out.rule_rollups[0]!;
    expect(roll.n_events).toBe(3);
    expect(roll.n_evaluable).toBe(1);
    expect(roll.rate).toBe(0);
    expect(roll.period_verdict).toBe("NON_CONCORDANT");
  });

  it("a patient controlled at every visit contributes no evaluable event", () => {
    const out = evaluateAllRuleEvents(rule, [], [
      visit("2025-11-15", "well_controlled", false),
      visit("2025-12-16", "well_controlled", false),
    ]);
    expect(out.rule_rollups[0]!.n_evaluable).toBe(0);
    expect(out.rule_rollups[0]!.period_verdict).toBe("EXCLUDED");
  });
});

describe("attribution matches the exacerbation arm, so the same situation reads the same", () => {
  it("a documented refusal or contraindication is a patient factor", () => {
    expect(judge(visit("2025-11-04", "not_well_controlled", false, "patient_refusal")).attribution)
      .toBe("PATIENT_FACTOR");
    expect(judge(visit("2025-11-04", "not_well_controlled", false, "contraindication")).attribution)
      .toBe("PATIENT_FACTOR");
  });

  it("a system barrier is a system factor", () => {
    expect(judge(visit("2025-11-04", "not_well_controlled", false, "system_barrier")).attribution)
      .toBe("SYSTEM_FACTOR");
  });

  it("the two arms use the SAME attribution expressions", () => {
    const a = skill.rules.find((r) => r.rule_id === "R-T1-ControllerForPersistent")!;
    const b = rule[0]!;
    expect(b.attribution_when).toEqual(a.attribution_when);
  });
});

// DECISION 7 (study lead 2026-09-03). `asthma_encounters` includes ED-only days.
// Stepping up daily controller therapy belongs to the clinician managing the
// chronic disease; an ED physician's task is acute stabilisation and ED discharge
// routinely defers the controller decision to the PCP, so scoring the gap here
// filed it against the wrong clinician. It also counted one visit twice — an
// asthma ED visit is ALREADY an exacerbation (feeding obligation_points, with its
// grace deadline) and already a follow-up trigger.
describe("decision 7: the controller-at-visit rules judge OUTPATIENT visits only", () => {
  const atKind = (kind: string | undefined, ruleId: string, control = "not_well_controlled"): RuleEvent => ({
    event_id: `${ruleId}@2025-03-02`, rule_id: ruleId,
    anchor: {
      type: "asthma_encounters", date: "2025-03-02", origin: "omop",
      ...(kind ? { meta: { kind } } : {}),
    },
    // Each of the three rules' OWN question is answered, so every case below
    // turns on the ED/outpatient gate rather than on the unanswered check that
    // precedes it.
    answers: [
      { question_id: "T1-ControlLevel", tier: 1, answer: control },
      { question_id: "T1-ControllerPrescribed", tier: 1, answer: false },
      { question_id: "T2-StepTherapyMatch", tier: 2, answer: "under_treated" },
      { question_id: "T2-FollowupScheduled", tier: 2, answer: true },
    ],
  } as RuleEvent);

  const judgeRule = (ruleId: string, e: RuleEvent) =>
    evaluateAllRuleEvents(skill.rules.filter((r) => r.rule_id === ruleId), [], [e]).rule_events[0]!;

  it("an ED-only uncontrolled visit is NOT evaluable", () => {
    expect(judgeRule(RULE_ID, atKind("ed", RULE_ID)).evaluable).toBe(false);
    expect(judgeRule("R-T2-StepTherapyMatches", atKind("ed", "R-T2-StepTherapyMatches")).evaluable)
      .toBe(false);
  });

  it("an outpatient uncontrolled visit is still judged", () => {
    const e = judgeRule(RULE_ID, atKind("outpatient", RULE_ID));
    expect(e.evaluable).toBe(true);
    expect(e.verdict).toBe("NON_CONCORDANT");
  });

  // Decision 6: a day carrying BOTH an ED visit and a clinic visit is labelled
  // "outpatient", because the clinician in clinic could have adjusted therapy.
  // Decision 7 rests on that label, so the mixed day stays in the denominator.
  it("a mixed ED+clinic day is labelled outpatient and stays judged", () => {
    expect(judgeRule(RULE_ID, atKind("outpatient", RULE_ID)).evaluable).toBe(true);
  });

  // Same convention as `_window_censored`: absent information is not evidence.
  // An anchor list with no setting concept (ocs_bursts) and an extract predating
  // `meta.kind` both keep their behaviour rather than silently emptying.
  it("an anchor carrying no kind at all is judged, as before", () => {
    expect(judgeRule(RULE_ID, atKind(undefined, RULE_ID)).evaluable).toBe(true);
  });

  it("R-T2-FollowupScheduled deliberately KEEPS ED anchors", () => {
    // Post-ED follow-up IS an EPR-3 requirement, and the responsible party there
    // is the system — which is exactly what that rule audits. The asymmetry is
    // the decision, so it is pinned rather than left to be tidied away later.
    const e = judgeRule("R-T2-FollowupScheduled", atKind("ed", "R-T2-FollowupScheduled"));
    expect(e.evaluable).toBe(true);
    expect(skill.rules.find((r) => r.rule_id === "R-T2-FollowupScheduled")!.event_evaluable_if)
      .not.toContain("_anchor_kind");
  });
});
