import { describe, it, expect } from "vitest";
import type { QuestionAnswer, RuleEvent } from "@chart-review/platform-types";
import {
  evaluateAllRules,
  evaluateAllRuleEvents,
  ENGINE_NOT_EVALUABLE_REASON,
  ENGINE_UNANSWERED_REASON,
  eventScopedQuestionsFor,
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

  it("an event_anchor rule with zero input events rolls up EXCLUDED — no window-stub fallback", () => {
    const out = evaluateAllRuleEvents([STEP_RULE], [], []);

    const stepEvents = out.rule_events.filter((e) => e.rule_id === "R-Step");
    expect(stepEvents).toHaveLength(0);

    const roll = out.rule_rollups.find((r) => r.rule_id === "R-Step")!;
    expect(roll.n_events).toBe(0);
    expect(roll.n_evaluable).toBe(0);
    expect(roll.n_concordant).toBe(0);
    expect(roll.n_non_concordant).toBe(0);
    expect(roll.n_excluded).toBe(0);
    expect(roll.rate).toBeNull();
    expect(roll.period_verdict).toBe("EXCLUDED");

    const verdict = out.rule_verdicts.find((v) => v.rule_id === "R-Step")!;
    expect(verdict.verdict).toBe("EXCLUDED");
    expect(verdict.attribution).toBeUndefined();
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

  it("a rule with a malformed expression yields a compile-error verdict without breaking other rules", () => {
    const badRule: RuleDefinition = {
      rule_id: "R-Bad",
      description: "malformed expression",
      verdict_if: "(((",
    };
    const patient = [qa("SpiroDate", "2024-03-01")];
    const out = evaluateAllRuleEvents([WINDOW_RULE, badRule], patient, []);

    const good = out.rule_verdicts.find((v) => v.rule_id === "R-Spiro")!;
    expect(good.verdict).toBe("CONCORDANT");

    const bad = out.rule_verdicts.find((v) => v.rule_id === "R-Bad")!;
    expect(bad.verdict).toBe("NON_CONCORDANT");
    expect(bad.attribution).toBe("OTHER");
    expect(bad.rationale).toMatch(/^rule compile error:/);

    const badRollup = out.rule_rollups.find((r) => r.rule_id === "R-Bad")!;
    expect(badRollup.n_events).toBe(1);
    expect(badRollup.n_evaluable).toBe(0);
    expect(badRollup.rate).toBeNull();
    expect(badRollup.period_verdict).toBe("NON_CONCORDANT");

    const badEvents = out.rule_events.filter((e) => e.rule_id === "R-Bad");
    expect(badEvents).toHaveLength(1);
    expect(badEvents[0].verdict).toBeUndefined();
  });

  it("the compile-error catch scrubs a stale verdict/attribution off a previously-evaluated event", () => {
    const priorEvent: RuleEvent = ev("R-Bad", "R-Bad@2024-01-01@e1", {
      verdict: "NON_CONCORDANT",
      attribution: "DOCUMENTATION_GAP",
    });
    const badRule: RuleDefinition = {
      rule_id: "R-Bad",
      description: "now-malformed expression",
      verdict_if: "(((",
    };
    const out = evaluateAllRuleEvents([badRule], [], [priorEvent]);

    const passedThrough = out.rule_events.find((e) => e.event_id === "R-Bad@2024-01-01@e1")!;
    expect(passedThrough.verdict).toBeUndefined();
    expect(passedThrough.attribution).toBeUndefined();
  });

  it("re-evaluating an engine-marked-not-evaluable event with the missing answer now present makes it evaluable", () => {
    const firstPass = evaluateAllRuleEvents(
      [STEP_RULE],
      [],
      [ev("R-Step", "R-Step@2024-02-01@e1", { answers: [qa("StepMatch", "matches")] })],
    );
    const notEvaluable = firstPass.rule_events[0];
    expect(notEvaluable.evaluable).toBe(false);
    expect(notEvaluable.evaluable_reason).toBe(ENGINE_NOT_EVALUABLE_REASON);

    const fedBack: RuleEvent = {
      ...notEvaluable,
      answers: [...(notEvaluable.answers ?? []), qa("ControlLevel", "well_controlled")],
    };
    const secondPass = evaluateAllRuleEvents([STEP_RULE], [], [fedBack]);
    const nowEvaluable = secondPass.rule_events[0];
    expect(nowEvaluable.evaluable).toBe(true);
    expect(nowEvaluable.verdict).toBe("CONCORDANT");
    expect(nowEvaluable.evaluable_reason).toBeUndefined();
  });

  it("events for an unknown rule_id pass through unevaluated with no rollup or verdict", () => {
    const orphan = ev("R-Nope", "R-Nope@2024-01-01@o1");
    const out = evaluateAllRuleEvents([STEP_RULE], [], [orphan]);

    const passthrough = out.rule_events.filter((e) => e.rule_id === "R-Nope");
    expect(passthrough).toHaveLength(1);
    expect(passthrough[0].verdict).toBeUndefined();
    expect(out.rule_rollups.some((r) => r.rule_id === "R-Nope")).toBe(false);
    expect(out.rule_verdicts.some((v) => v.rule_id === "R-Nope")).toBe(false);
  });

  it("a mixed rollup with an EXCLUDED event keeps it out of n_evaluable and the rate", () => {
    const events = [
      ev("R-Step", "R-Step@2024-02-01@e1", { answers: [qa("ControlLevel", "well_controlled"), qa("StepMatch", "matches")] }),
      ev("R-Step", "R-Step@2024-11-14@e2", { answers: [qa("ControlLevel", "not_well_controlled"), qa("StepMatch", "unknown")] }),
      ev("R-Step", "R-Step@2024-12-02@e3", { answers: [qa("ControlLevel", "not_well_controlled"), qa("StepMatch", "under_treated")] }),
    ];
    const out = evaluateAllRuleEvents([STEP_RULE], [], events);
    const roll = out.rule_rollups[0];
    const excludedEvent = out.rule_events.find((e) => e.event_id === "R-Step@2024-11-14@e2")!;
    expect(excludedEvent.verdict).toBe("EXCLUDED");
    expect(roll.n_events).toBe(3);
    expect(roll.n_excluded).toBe(1);
    expect(roll.n_evaluable).toBe(2);
    expect(roll.rate).toBeCloseTo(1 / 2);
    expect(roll.period_verdict).toBe("NON_CONCORDANT");
  });
});

// ── event_scoped_questions: no whole-window fallback ─────────────────────────
//
// Regression for the collapse the event model exists to remove. Before
// `event_scoped_questions`, patient-level answers were inherited by every
// event, so an agent (or annotator) who committed only the rule's own answer
// per event had each event's EVALUABILITY decided by the whole-window value.
// Measured on a shipped fixture run: no event carried ControlLevel, every
// event inherited the window's "not_well_controlled", and zero events across
// the entire run were ever marked not-evaluable.

const SCOPED_STEP_RULE: RuleDefinition = {
  ...STEP_RULE,
  event_scoped_questions: ["ControlLevel", "StepMatch"],
};

describe("event-scoped questions are never inherited from patient level", () => {
  it("an event that did not commit the scoped question is NOT evaluable", () => {
    const patient = [qa("ControlLevel", "not_well_controlled")];
    const events = [ev("R-Step", "R-Step@2024-11-14@e1", { answers: [qa("StepMatch", "matches")] })];
    const { rule_events, rule_rollups } = evaluateAllRuleEvents([SCOPED_STEP_RULE], patient, events);
    expect(rule_events[0].evaluable).toBe(false);
    expect(rule_events[0].evaluable_reason).toBe(ENGINE_NOT_EVALUABLE_REASON);
    expect(rule_events[0].verdict).toBeUndefined();
    expect(rule_rollups[0].n_evaluable).toBe(0);
    expect(rule_rollups[0].rate).toBeNull();
  });

  it("the same event IS evaluable once it commits the scoped question itself", () => {
    const patient = [qa("ControlLevel", "not_well_controlled")];
    const events = [ev("R-Step", "R-Step@2024-11-14@e1", {
      answers: [qa("ControlLevel", "well_controlled"), qa("StepMatch", "matches")],
    })];
    const { rule_events } = evaluateAllRuleEvents([SCOPED_STEP_RULE], patient, events);
    expect(rule_events[0].evaluable).toBe(true);
    expect(rule_events[0].verdict).toBe("CONCORDANT");
  });

  it("the event's own value wins over the patient-level one, not merely shadows it", () => {
    // Patient-level says under_treated; this event says matches. Were the
    // window value reaching the rule at all, the verdict would flip.
    const patient = [qa("ControlLevel", "very_poorly_controlled"), qa("StepMatch", "under_treated")];
    const events = [ev("R-Step", "R-Step@2024-11-14@e1", {
      answers: [qa("ControlLevel", "well_controlled"), qa("StepMatch", "matches")],
    })];
    const { rule_events } = evaluateAllRuleEvents([SCOPED_STEP_RULE], patient, events);
    expect(rule_events[0].verdict).toBe("CONCORDANT");
  });

  it("questions NOT marked event-scoped are still inherited", () => {
    // AgeBand is genuinely patient-level: withholding it too would break
    // every rule that legitimately reads window-level context.
    const rule: RuleDefinition = {
      rule_id: "R-Ctx",
      description: "uses a patient-level question alongside an event-scoped one",
      event_anchor: "visits",
      event_evaluable_if: 'AgeBand is present',
      verdict_if: 'StepMatch == "matches"',
      attribution: "DOCUMENTATION_GAP",
      event_scoped_questions: ["StepMatch"],
    };
    const patient = [qa("AgeBand", "age_5_11")];
    const events = [ev("R-Ctx", "R-Ctx@2024-11-14@e1", { answers: [qa("StepMatch", "matches")] })];
    const { rule_events } = evaluateAllRuleEvents([rule], patient, events);
    expect(rule_events[0].evaluable).toBe(true);
    expect(rule_events[0].verdict).toBe("CONCORDANT");
  });

  it("a window stub still inherits everything, including event-scoped questions", () => {
    // A window stub IS the observation window, so anchor-free rules must stay
    // byte-identical no matter what the questions are flagged as.
    const rule: RuleDefinition = {
      ...WINDOW_RULE,
      event_scoped_questions: ["SpiroDate"],
    };
    const patient = [qa("SpiroDate", "2024-03-01")];
    const withFlag = evaluateAllRuleEvents([rule], patient, []);
    const withoutFlag = evaluateAllRuleEvents([WINDOW_RULE], patient, []);
    expect(withFlag.rule_verdicts).toEqual(withoutFlag.rule_verdicts);
    expect(withFlag.rule_verdicts[0].verdict).toBe("CONCORDANT");
  });
});

// ── unanswered events are not judged ────────────────────────────────────────
//
// Regression for what the live fixture run surfaced: a follow-up event whose
// answer list was EMPTY was scored NON_CONCORDANT, because an absent
// question_id compares false and false means "no follow-up was arranged".
// "Nobody looked" and "we looked and found none" are different claims, and
// only the second is a care gap.

describe("an anchored event missing its rule's own answer is unanswered, not judged", () => {
  const RULE: RuleDefinition = {
    rule_id: "R-Follow",
    description: "follow-up arranged within 3 months of this event",
    event_anchor: "visits",
    verdict_if: "Followup == true",
    attribution: "DOCUMENTATION_GAP",
    event_scoped_questions: ["Followup"],
  };

  it("an empty answer list yields evaluable:false with the unanswered reason, not NON_CONCORDANT", () => {
    const events = [ev("R-Follow", "R-Follow@2025-01-10@e1", { answers: [] })];
    const { rule_events, rule_rollups } = evaluateAllRuleEvents([RULE], [], events);
    expect(rule_events[0].evaluable).toBe(false);
    expect(rule_events[0].evaluable_reason).toBe(ENGINE_UNANSWERED_REASON);
    expect(rule_events[0].verdict).toBeUndefined();
    expect(rule_rollups[0].n_non_concordant).toBe(0);
    expect(rule_rollups[0].n_evaluable).toBe(0);
    expect(rule_rollups[0].period_verdict).toBe("EXCLUDED");
  });

  it("a committed FALSE answer still counts as a real gap", () => {
    // The distinction has to cut only one way: an annotator or agent who
    // looked and recorded "no follow-up arranged" must still produce a
    // NON_CONCORDANT event.
    const events = [ev("R-Follow", "R-Follow@2025-01-10@e1", { answers: [qa("Followup", false)] })];
    const { rule_events, rule_rollups } = evaluateAllRuleEvents([RULE], [], events);
    expect(rule_events[0].evaluable).toBe(true);
    expect(rule_events[0].verdict).toBe("NON_CONCORDANT");
    expect(rule_rollups[0].n_non_concordant).toBe(1);
  });

  it("answering some OTHER event's question does not make the event answered", () => {
    const events = [ev("R-Follow", "R-Follow@2025-01-10@e1", { answers: [qa("StepMatch", "matches")] })];
    const { rule_events } = evaluateAllRuleEvents([RULE], [], events);
    expect(rule_events[0].evaluable_reason).toBe(ENGINE_UNANSWERED_REASON);
  });

  it("a window stub is exempt — it legitimately reads patient-level answers", () => {
    const windowRule: RuleDefinition = { ...RULE, event_anchor: undefined, event_scoped_questions: [] };
    const { rule_verdicts } = evaluateAllRuleEvents([windowRule], [qa("Followup", true)], []);
    expect(rule_verdicts[0].verdict).toBe("CONCORDANT");
  });
});

describe("eventScopedQuestionsFor", () => {
  it("splits the questions that decide a verdict from those that decide applicability", () => {
    const rule: RuleDefinition = {
      rule_id: "R-Step",
      description: "d",
      event_anchor: "visits",
      verdict_if: 'StepMatch == "matches"',
      excluded_if: 'StepMatch == "unknown"',
      event_evaluable_if: 'ControlLevel is present and ControlLevel != "undetermined"',
      event_scoped_questions: ["StepMatch", "ControlLevel"],
    };
    expect(eventScopedQuestionsFor(rule)).toEqual({
      verdict: ["StepMatch"],
      evaluability: ["ControlLevel"],
    });
  });

  it("omits questions the task did not mark event-scoped — those are inherited", () => {
    const rule: RuleDefinition = {
      rule_id: "R-Ctx",
      description: "d",
      event_anchor: "visits",
      verdict_if: 'StepMatch == "matches" and AgeBand == "age_5_11"',
      event_scoped_questions: ["StepMatch"],
    };
    expect(eventScopedQuestionsFor(rule).verdict).toEqual(["StepMatch"]);
  });
});
