import { describe, it, expect } from "vitest";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import {
  evaluateAllRuleEvents, periodRequiredQuestions, isAnswered, windowEventStub,
  absenceTestedQuestions,
  ENGINE_PERIOD_UNANSWERED_REASON, ENGINE_UNANSWERED_REASON,
} from "./index.js";
import type { QuestionAnswer, RuleEvent } from "@chart-review/platform-types";

// A COMMITTED answer whose VALUE is null is not an answer. The two unanswered
// guards keyed on the question_id alone, so a null slipped past them and was then
// read as a NEGATIVE by every comparison — measured on the real asthma rubric:
// all 6 window rules with a required question produced a verdict from an all-null
// answer set, 5 of them NON_CONCORDANT.
//
// Null is not hypothetical. An extractor that looked and could not determine the
// value commits one, and `coerce()` produces one whenever an answer is not in the
// question's enum — which happened this month, when a criterion still instructed
// agents to use an enum value that had been deleted from the rubric.

const nullAnswers = (qids: string[]): QuestionAnswer[] =>
  qids.map((q) => ({ question_id: q, tier: 1, answer: null, source: "agent" as const }));

// The same stub expandEventWorklist puts on a window rule, so the guard is
// exercised against the shape the pipeline actually produces.
const windowEvent = windowEventStub;

describe("isAnswered", () => {
  it("agrees with the engine's own `is missing` — a committed null is absent", () => {
    expect(isAnswered({ question_id: "Q", tier: 1, answer: null })).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered({ question_id: "Q", tier: 1, answer: false })).toBe(true);
    expect(isAnswered({ question_id: "Q", tier: 1, answer: 0 })).toBe(true);
    expect(isAnswered({ question_id: "Q", tier: 1, answer: "" })).toBe(true);
  });
});

describe("a null answer is UNANSWERED, never a care gap — real asthma rubric", () => {
  const skill = loadAdherenceSkill("asthma-adherence");
  const windowRules = skill.rules.filter((r) => periodRequiredQuestions(r).length > 0);

  it("covers every window rule that reads a period question", () => {
    // Guards the test itself: if the rubric grows a rule, it is exercised below.
    expect(windowRules.length).toBeGreaterThanOrEqual(6);
  });

  for (const rule of windowRules) {
    it(`${rule.rule_id} refuses to judge`, () => {
      const req = periodRequiredQuestions(rule);
      const out = evaluateAllRuleEvents([rule], nullAnswers(req), [windowEvent(rule.rule_id)]);
      const e = out.rule_events[0]!;
      expect(e.evaluable).toBe(false);
      expect(e.evaluable_reason).toContain(ENGINE_PERIOD_UNANSWERED_REASON);
      expect(e.verdict).toBeUndefined();
      // "(null)" separates "committed with no value" from "never committed" —
      // the reviewer needs to know whether anybody looked.
      expect(e.evaluable_reason).toContain("(null)");
    });
  }

  it("and still judges normally once a real value arrives", () => {
    // The guard must not swallow answerable rules: same rule, same event, with
    // the required question given an actual value, produces a verdict again.
    const rule = windowRules.find((r) => r.rule_id === "R-T2-WrittenActionPlan")!;
    const req = periodRequiredQuestions(rule);
    const answers: QuestionAnswer[] = req.map((q) => ({
      question_id: q, tier: 2, answer: true, source: "agent" as const,
    }));
    const out = evaluateAllRuleEvents([rule], answers, [windowEvent(rule.rule_id)]);
    expect(out.rule_events[0]!.evaluable).not.toBe(false);
    expect(out.rule_events[0]!.verdict).toBeDefined();
  });
});

describe("a question tested for ABSENCE needs an entry, not a value", () => {
  // The rule declared what "no value" means, so a null there is DATA. Silence is
  // not: a question nobody answered must not be read as "absent from the chart".
  const skill = loadAdherenceSkill("asthma-adherence");
  const spiro = skill.rules.find((r) => r.rule_id === "R-T1-SpirometryWithin24mo")!;
  const saba = skill.rules.find((r) => r.rule_id === "R-T1-NoSABAOveruse")!;

  it("the rubric still writes this rule as an absence test", () => {
    // If the rule is ever rewritten to compare a value, the cases below stop
    // testing what they claim to.
    expect(absenceTestedQuestions(spiro).period).toEqual(["T1-SpirometryDate"]);
    expect(periodRequiredQuestions(spiro)).toEqual([]);
  });

  it("SKIPPED spirometry is UNANSWERED, not a documentation gap", () => {
    const out = evaluateAllRuleEvents([spiro], [], [windowEvent(spiro.rule_id)]);
    const e = out.rule_events[0]!;
    expect(e.evaluable).toBe(false);
    expect(e.evaluable_reason).toContain("T1-SpirometryDate");
    expect(e.verdict).toBeUndefined();
  });

  it("but a COMMITTED null spirometry date IS the documentation gap", () => {
    // The finding the rule exists to make: somebody looked, and the chart has no
    // spirometry. This must keep working — it is not the bug.
    const out = evaluateAllRuleEvents(
      [spiro],
      [{ question_id: "T1-SpirometryDate", tier: 1, answer: null, source: "agent" }],
      [windowEvent(spiro.rule_id)],
    );
    const e = out.rule_events[0]!;
    expect(e.evaluable).not.toBe(false);
    expect(e.verdict).toBe("NON_CONCORDANT");
    expect(e.attribution).toBe("DOCUMENTATION_GAP");
  });

  it("and a real date is concordant", () => {
    const out = evaluateAllRuleEvents(
      [spiro],
      [{ question_id: "T1-SpirometryDate", tier: 1, answer: "2025-03-04", source: "agent" }],
      [windowEvent(spiro.rule_id)],
    );
    expect(out.rule_events[0]!.verdict).toBe("CONCORDANT");
  });

  it("R-T1-NoSABAOveruse keeps its declared drop-the-patient behavior on a committed null", () => {
    const out = evaluateAllRuleEvents(
      [saba],
      [{ question_id: "T1-SABAOveruse", tier: 1, answer: null, source: "agent" }],
      [windowEvent(saba.rule_id)],
    );
    expect(out.rule_events[0]!.verdict).toBe("EXCLUDED");
  });

  it("but silence no longer reaches it — nobody looked is not 'no medication documented'", () => {
    const out = evaluateAllRuleEvents([saba], [], [windowEvent(saba.rule_id)]);
    expect(out.rule_events[0]!.evaluable).toBe(false);
    expect(out.rule_events[0]!.verdict).toBeUndefined();
  });
});

describe("the same two levels apply per EVENT", () => {
  // No rule in the rubric tests an event-scoped question for absence today, so
  // this pins the path a future one would take rather than current behavior.
  const rule = {
    rule_id: "R-EventAbsence", description: "probe",
    verdict_if: "Q-Event is present",
    event_scoped_questions: ["Q-Event"],
  } as never;
  const event = (answers?: unknown[]) => ({
    event_id: "e1", rule_id: "R-EventAbsence",
    anchor: { type: "asthma_encounters", date: "2025-11-15", origin: "omop" },
    ...(answers ? { answers } : {}),
  } as unknown as RuleEvent);

  it("a committed null on the event is DATA — the rule reads the absence", () => {
    const out = evaluateAllRuleEvents([rule], [],
      [event([{ question_id: "Q-Event", tier: 2, answer: null, source: "agent" }])]);
    expect(out.rule_events[0]!.evaluable).not.toBe(false);
    expect(out.rule_events[0]!.verdict).toBe("NON_CONCORDANT");
  });

  it("an event with no entry at all is still unanswered", () => {
    const out = evaluateAllRuleEvents([rule], [], [event()]);
    expect(out.rule_events[0]!.evaluable).toBe(false);
    expect(out.rule_events[0]!.evaluable_reason).toBe(ENGINE_UNANSWERED_REASON);
  });
});

describe("an anchored event answered with nulls is unanswered too", () => {
  it("does not score a verdict off them", () => {
    const rule = {
      rule_id: "R-Probe", description: "probe",
      verdict_if: 'Q-Event == "done"',
      event_scoped_questions: ["Q-Event"],
    } as never;
    const ev = {
      event_id: "e1", rule_id: "R-Probe",
      anchor: { type: "asthma_encounters", date: "2025-11-15", origin: "omop" },
      answers: [{ question_id: "Q-Event", tier: 2, answer: null, source: "agent" }],
    } as unknown as RuleEvent;
    const out = evaluateAllRuleEvents([rule], [], [ev]);
    expect(out.rule_events[0]!.evaluable).toBe(false);
    expect(out.rule_events[0]!.evaluable_reason).toBe(ENGINE_UNANSWERED_REASON);
    expect(out.rule_events[0]!.verdict).toBeUndefined();
  });
});
