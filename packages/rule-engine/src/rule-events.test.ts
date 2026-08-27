import { describe, it, expect } from "vitest";
import type { QuestionAnswer, RuleEvent } from "@chart-review/platform-types";
import {
  evaluateAllRules,
  evaluateAllRuleEvents,
  ENGINE_NOT_EVALUABLE_REASON,
  ENGINE_UNANSWERED_REASON,
  eventScopedQuestionsFor,
  deriveWorstControlLevel,
  withDerivedAnswers,
  rulesReadingQid,
  DERIVED_WORST_CONTROL_QID,
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

describe("derived patient-level answers (worst control level)", () => {
  // A rule with an EVENT-LEVEL TRIGGER but a WINDOW-LEVEL ACTION: the workup is
  // indicated by how controlled the asthma was (judged per visit), but is done
  // once and covers the period. Its gate therefore reads the derived value.
  const COMORBID_RULE: RuleDefinition = {
    rule_id: "R-Comorbid",
    description: "comorbidity workup when asthma cannot be well controlled",
    verdict_if: 'Comorbid in ["assessed_and_addressed", "assessed_not_addressed"]',
    excluded_if: `${DERIVED_WORST_CONTROL_QID} == "well_controlled"`,
    attribution: "DOCUMENTATION_GAP",
  };
  const visit = (id: string, level: string): RuleEvent =>
    ev("R-Step", id, { answers: [qa("T1-ControlLevel", level), qa("StepMatch", "matches")] });

  it("takes the WORST level across events, not the most recent", () => {
    // March well, July uncontrolled, November well — the shape the old
    // instruction ("not_applicable when T1-ControlLevel == well_controlled")
    // had no answer for.
    expect(deriveWorstControlLevel([
      visit("e1", "well_controlled"),
      visit("e2", "not_well_controlled"),
      visit("e3", "well_controlled"),
    ])).toBe("not_well_controlled");
    expect(deriveWorstControlLevel([
      visit("e1", "not_well_controlled"),
      visit("e2", "very_poorly_controlled"),
    ])).toBe("very_poorly_controlled");
  });

  it("ignores undetermined — it is not a degree of control", () => {
    expect(deriveWorstControlLevel([
      visit("e1", "undetermined"),
      visit("e2", "well_controlled"),
    ])).toBe("well_controlled");
    expect(deriveWorstControlLevel([visit("e1", "undetermined")])).toBeNull();
    expect(deriveWorstControlLevel([])).toBeNull();
  });

  it("EXCLUDES a patient well controlled at EVERY visit", () => {
    const res = evaluateAllRuleEvents(
      [COMORBID_RULE],
      [qa("Comorbid", "not_assessed")],
      [visit("e1", "well_controlled"), visit("e2", "well_controlled")],
    );
    expect(res.rule_verdicts[0]!.verdict).toBe("EXCLUDED");
    expect(res.derived_answers).toEqual([expect.objectContaining({
      question_id: DERIVED_WORST_CONTROL_QID, answer: "well_controlled", source: "derived",
    })]);
  });

  it("COUNTS a patient uncontrolled at any visit, even if the last visit was fine", () => {
    // The whole point of "worst": under a most-recent rule this patient would be
    // excluded, and the excluded patients are the ones most likely to have no
    // workup — the reported rate would rise for a reason that isn't care.
    const res = evaluateAllRuleEvents(
      [COMORBID_RULE],
      [qa("Comorbid", "not_assessed")],
      [visit("e1", "not_well_controlled"), visit("e2", "well_controlled")],
    );
    expect(res.rule_verdicts[0]!.verdict).toBe("NON_CONCORDANT");
  });

  it("keeps the patient IN when no visit established a control level", () => {
    // Fails toward measuring rather than toward silently dropping patients —
    // matches v0.5's "when undetermined, do NOT answer not_applicable".
    const res = evaluateAllRuleEvents(
      [COMORBID_RULE], [qa("Comorbid", "assessed_and_addressed")], [visit("e1", "undetermined")],
    );
    expect(res.rule_verdicts[0]!.verdict).toBe("CONCORDANT");
    expect(res.derived_answers).toEqual([]);
  });

  it("drops a stale derived answer instead of reading the pre-edit value", () => {
    const stale = { ...qa(DERIVED_WORST_CONTROL_QID, "very_poorly_controlled"), source: "derived" as const };
    const out = withDerivedAnswers([stale, qa("Comorbid", "not_assessed")], [visit("e1", "well_controlled")]);
    expect(out.filter((a) => a.question_id === DERIVED_WORST_CONTROL_QID))
      .toEqual([expect.objectContaining({ answer: "well_controlled" })]);
  });

  it("rulesReadingQid finds the rules a derived-input change invalidates", () => {
    expect(rulesReadingQid([COMORBID_RULE, STEP_RULE, WINDOW_RULE], DERIVED_WORST_CONTROL_QID)
      .map((r) => r.rule_id)).toEqual(["R-Comorbid"]);
  });
});

describe("a censored judgment deadline is not a care gap", () => {
  // The controller obligation runs to the patient's next asthma visit. When no
  // such visit is observed, the ETL censors the deadline at the index date and
  // flags it: the grace period ran past the end of observation, so the chart
  // CANNOT show whether the controller was started in time. The flag existed and
  // nothing read it, so 8% of obligation points in the corpus were scored as care
  // gaps the data does not support — and this rule has no other escape hatch.
  const OBLIGATION_RULE: RuleDefinition = {
    rule_id: "R-Controller",
    description: "controller active by the obligation's deadline",
    event_anchor: "obligation_points",
    event_censored_if: "_deadline_censored == true",
    event_censored_reason: "grace period ran past the end of observation",
    verdict_if: "T1-ControllerPrescribed == true",
    event_scoped_questions: ["T1-ControllerPrescribed"],
    attribution: "DOCUMENTATION_GAP",
  };
  const point = (over: Partial<RuleEvent["anchor"]> = {}, answers?: QuestionAnswer[]): RuleEvent => ({
    event_id: "R-Controller@2025-09-03@drugs:1",
    rule_id: "R-Controller",
    anchor: { type: "obligation_points", date: "2025-09-03", origin: "omop", ...over },
    ...(answers ? { answers } : {}),
  });

  it("an uncensored deadline is judged normally", () => {
    const res = evaluateAllRuleEvents([OBLIGATION_RULE], [], [
      point({ meta: { deadline: "2025-11-20", deadline_censored: false } },
        [qa("T1-ControllerPrescribed", false)]),
    ]);
    expect(res.rule_events[0]!.evaluable).toBe(true);
    expect(res.rule_events[0]!.verdict).toBe("NON_CONCORDANT");
  });

  it("a censored deadline is NOT evaluable, and says why", () => {
    const res = evaluateAllRuleEvents([OBLIGATION_RULE], [], [
      point({ meta: { deadline: "2026-04-12", deadline_censored: true } },
        [qa("T1-ControllerPrescribed", false)]),
    ]);
    const e = res.rule_events[0]!;
    expect(e.evaluable).toBe(false);
    expect(e.evaluable_reason).toBe("grace period ran past the end of observation");
    expect(e.verdict).toBeUndefined();
    // Not counted either way — it leaves the denominator rather than failing.
    expect(res.rule_rollups[0]).toMatchObject({ n_events: 1, n_evaluable: 0, rate: null });
  });

  it("a censored deadline reports the CENSORING, not 'unanswered', when nobody answered", () => {
    // The gate reads only anchor facts, so it is decidable before any answer
    // exists and must run first: "this event can never be judged" is a different
    // finding from "nobody looked", and the more important one.
    const res = evaluateAllRuleEvents([OBLIGATION_RULE], [], [
      point({ meta: { deadline: "2026-04-12", deadline_censored: true } }),
    ]);
    expect(res.rule_events[0]!.evaluable_reason).toBe("grace period ran past the end of observation");
    expect(res.rule_events[0]!.evaluable_reason).not.toBe(ENGINE_UNANSWERED_REASON);
  });

  it("an UNcensored event with no answer is still UNANSWERED, not censored", () => {
    const res = evaluateAllRuleEvents([OBLIGATION_RULE], [], [
      point({ meta: { deadline: "2025-11-20", deadline_censored: false } }),
    ]);
    expect(res.rule_events[0]!.evaluable_reason).toBe(ENGINE_UNANSWERED_REASON);
  });

  it("re-evaluation is idempotent: the custom reason is re-derived, not frozen", () => {
    // Without rule.event_not_evaluable_reason in the engine-reason set, a
    // round-tripped event would short-circuit as agent-authored and never flip
    // back when the censoring is corrected upstream.
    const censored = evaluateAllRuleEvents([OBLIGATION_RULE], [], [
      point({ meta: { deadline: "2026-04-12", deadline_censored: true } },
        [qa("T1-ControllerPrescribed", true)]),
    ]).rule_events[0]!;
    const fixed = evaluateAllRuleEvents([OBLIGATION_RULE], [], [
      { ...censored, anchor: { ...censored.anchor, meta: { deadline: "2025-11-20", deadline_censored: false } } },
    ]).rule_events[0]!;
    expect(fixed.evaluable).toBe(true);
    expect(fixed.verdict).toBe("CONCORDANT");
  });

  it("an agent-authored not-evaluable reason still short-circuits", () => {
    const res = evaluateAllRuleEvents([OBLIGATION_RULE], [], [
      { ...point({ meta: { deadline: "2025-11-20" } }), evaluable: false,
        evaluable_reason: "chart has no medication documentation at all" },
    ]);
    expect(res.rule_events[0]!.evaluable_reason).toBe("chart has no medication documentation at all");
  });

  it("a synthetic anchor fact cannot be spoofed by an event answer", () => {
    const res = evaluateAllRuleEvents([OBLIGATION_RULE], [], [
      point({ meta: { deadline: "2026-04-12", deadline_censored: true } },
        [qa("T1-ControllerPrescribed", false), qa("_deadline_censored", false)]),
    ]);
    expect(res.rule_events[0]!.evaluable).toBe(false);
  });
});

describe("an unobserved tail censors the NEGATIVE only", () => {
  // The follow-up rule judges a 90-day SPAN. 21.5% of its anchors in the local
  // corpus sit close enough to the index date that the span runs past the end of
  // observation, and every one of them used to be judged as if the whole 90 days
  // had been seen. But the two answers are not symmetric: a follow-up that IS
  // documented settles the event (no further observation can unmeet a met
  // requirement), while one that is NOT documented settles nothing — it may have
  // been arranged in the days the extract does not cover. Dropping the whole
  // event would throw away the conclusive positives.
  const FOLLOWUP_RULE: RuleDefinition = {
    rule_id: "R-Followup",
    description: "follow-up within 3 months of the event",
    event_anchor: "asthma_encounters",
    event_window_days: 90,
    event_censored_if: '_window_censored == true and Followup != true',
    event_censored_reason: "window runs past the end of observation, no follow-up seen in the observed part",
    verdict_if: "Followup == true",
    event_scoped_questions: ["Followup"],
    attribution: "DOCUMENTATION_GAP",
  };
  const visit = (daysToIndex: number, followup: boolean | undefined): RuleEvent => ({
    event_id: `e@${daysToIndex}`, rule_id: "R-Followup",
    anchor: { type: "asthma_encounters", date: "2025-11-15", origin: "omop",
              meta: { days_to_index: daysToIndex } },
    ...(followup === undefined ? {} : {
      answers: [{ question_id: "Followup", tier: 2, answer: followup }] }),
  });
  const run = (e: RuleEvent) => evaluateAllRuleEvents([FOLLOWUP_RULE], [], [e]).rule_events[0]!;

  it("window fully observed: both answers are judged", () => {
    expect(run(visit(200, true))).toMatchObject({ evaluable: true, verdict: "CONCORDANT" });
    expect(run(visit(200, false))).toMatchObject({ evaluable: true, verdict: "NON_CONCORDANT" });
  });

  it("window truncated + follow-up FOUND: still conclusive", () => {
    // The whole point of censoring the negative only.
    expect(run(visit(30, true))).toMatchObject({ evaluable: true, verdict: "CONCORDANT" });
  });

  it("window truncated + follow-up NOT found: censored, not a care gap", () => {
    const e = run(visit(30, false));
    expect(e.evaluable).toBe(false);
    expect(e.evaluable_reason).toBe(FOLLOWUP_RULE.event_censored_reason);
    expect(e.verdict).toBeUndefined();
  });

  it("boundary: exactly the declared window is fully observed", () => {
    expect(run(visit(90, false))).toMatchObject({ evaluable: true, verdict: "NON_CONCORDANT" });
    expect(run(visit(89, false))).toMatchObject({ evaluable: false });
  });

  it("an asymmetric gate needs the answer, so unanswered is still UNANSWERED", () => {
    // `_window_censored == true and Followup != true` reads an event-scoped
    // question, so it cannot run before the unanswered check — and should not:
    // with no answer there is nothing to call conclusive either way.
    expect(run(visit(30, undefined)).evaluable_reason).toBe(ENGINE_UNANSWERED_REASON);
  });

  it("no days_to_index (extract predating the field) judges as before", () => {
    const e: RuleEvent = {
      event_id: "e0", rule_id: "R-Followup",
      anchor: { type: "asthma_encounters", date: "2025-11-15", origin: "omop" },
      answers: [{ question_id: "Followup", tier: 2, answer: false }],
    };
    expect(run(e)).toMatchObject({ evaluable: true, verdict: "NON_CONCORDANT" });
  });

  it("a rule with no declared window is never window-censored", () => {
    const pointRule = { ...FOLLOWUP_RULE, event_window_days: undefined };
    const res = evaluateAllRuleEvents([pointRule], [], [visit(1, false)]);
    expect(res.rule_events[0]).toMatchObject({ evaluable: true, verdict: "NON_CONCORDANT" });
  });

  it("applicability is reported BEFORE censoring, not as censoring", () => {
    // An event the requirement does not apply to is not "censored" — saying so
    // would misreport why it left the denominator.
    const gated = { ...FOLLOWUP_RULE, event_evaluable_if: 'Applies == true',
                    event_scoped_questions: ["Followup", "Applies"] };
    const e = { ...visit(30, false) } as RuleEvent;
    e.answers = [...(e.answers ?? []), { question_id: "Applies", tier: 2, answer: false }];
    const out = evaluateAllRuleEvents([gated], [], [e]).rule_events[0]!;
    expect(out.evaluable_reason).toBe(ENGINE_NOT_EVALUABLE_REASON);
  });
});
