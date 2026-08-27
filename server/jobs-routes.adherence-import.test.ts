import { describe, it, expect } from "vitest";
import { mergeAdherenceImport } from "./jobs-routes.js";
import type { RuleEvent, RuleRollup } from "@chart-review/platform-types";

// The adherence half of /import had NO tests — the only import test covers
// phenotype's encounters + field_assessments. Its merge is five fields with four
// different semantics (reviewer-win by stable id; wholesale replace; per-agent
// merge; derived-rollup-per-rule), and it is what runs when a session does a
// SECOND round: agent re-runs, the reviewer's prior adjudication must survive,
// and the Agent column must show the NEW draft.
//
// v0.6 then handed it two shapes it had never seen — a third answer source
// ("derived") and two new evaluable_reason values (censored / unanswered) — and
// the merge's reviewer-win test is a binary on source === "reviewer". These pin
// what happens to both.

const draftInput = (over: Partial<Parameters<typeof mergeAdherenceImport>[1]> = {}) => ({
  questionAnswers: [] as unknown[],
  ruleVerdicts: [] as unknown[],
  ruleEvents: [] as RuleEvent[],
  ruleRollups: [] as RuleRollup[],
  agentQuestionAnswers: {} as Record<string, unknown[]>,
  agentRuleVerdicts: {} as Record<string, unknown[]>,
  agentRuleEvents: {} as Record<string, RuleEvent[]>,
  ...over,
});

const qa = (id: string, answer: unknown, source?: string) =>
  ({ question_id: id, tier: 1, answer, ...(source ? { source } : {}) });

const ev = (id: string, over: Partial<RuleEvent> = {}): RuleEvent => ({
  event_id: id, rule_id: "R-Step",
  anchor: { type: "asthma_encounters", date: "2025-11-15", origin: "omop" },
  ...over,
});

describe("second round in one session: the reviewer's work survives", () => {
  it("a reviewer-edited answer wins; everything else takes the new draft", () => {
    const out = mergeAdherenceImport(
      { question_answers: [qa("Q1", true, "reviewer"), qa("Q2", "old", "agent")] },
      draftInput({ questionAnswers: [qa("Q1", false, "agent"), qa("Q2", "new", "agent")] }),
    );
    const byId = Object.fromEntries(
      (out.question_answers as Array<{ question_id: string; answer: unknown }>)
        .map((q) => [q.question_id, q.answer]));
    expect(byId.Q1).toBe(true);    // reviewer's, not the draft's false
    expect(byId.Q2).toBe("new");   // untouched by the reviewer -> refreshed
  });

  it("a reviewer-marked not-evaluable event survives the re-import", () => {
    // The case a reviewer would notice immediately: they judged an event
    // unjudgeable, the agent re-ran, and their mark has to still be there.
    const reviewerMark = ev("e1", {
      source: "reviewer", evaluable: false, evaluable_reason: "chart has no medication list",
    });
    const out = mergeAdherenceImport(
      { rule_events: [reviewerMark] },
      draftInput({ ruleEvents: [ev("e1", { evaluable: true, verdict: "NON_CONCORDANT" })] }),
    );
    const merged = out.rule_events as RuleEvent[];
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evaluable).toBe(false);
    expect(merged[0]!.evaluable_reason).toBe("chart has no medication list");
  });

  it("an ENGINE-marked not-evaluable event is NOT preserved — it is re-derived", () => {
    // v0.6 gave the engine two of its own reasons (censored deadline, unanswered
    // question). They carry source:"rule_engine"/none, not "reviewer", so the
    // fresh draft wins — which is right: they are recomputed every pass, and
    // freezing one would keep an event censored after the censoring was fixed.
    const out = mergeAdherenceImport(
      { rule_events: [ev("e1", { evaluable: false, evaluable_reason: "grace period ran past the end of observation" })] },
      draftInput({ ruleEvents: [ev("e1", { evaluable: true, verdict: "CONCORDANT" })] }),
    );
    const merged = out.rule_events as RuleEvent[];
    expect(merged[0]!.evaluable).toBe(true);
    expect(merged[0]!.evaluable_reason).toBeUndefined();
  });

  it("a reviewer event the new work-list no longer enumerates is kept, not dropped", () => {
    const out = mergeAdherenceImport(
      { rule_events: [ev("gone", { source: "reviewer", verdict: "CONCORDANT" })] },
      draftInput({ ruleEvents: [ev("e1")] }),
    );
    expect((out.rule_events as RuleEvent[]).map((e) => e.event_id).sort())
      .toEqual(["e1", "gone"]);
  });
});

describe("the derived answer is refreshed, never preserved", () => {
  // T1-WorstControlLevel is computed by the engine from the per-event control
  // levels. reviewer-win keys on source === "reviewer", and "derived" is not
  // that — so the new draft's value wins. That is the correct side of the
  // binary: a derived value must track the events it is derived FROM, and a
  // preserved one would outlive the answers that produced it.

  it("takes the new draft's derived value over the stored one", () => {
    const out = mergeAdherenceImport(
      { question_answers: [qa("T1-WorstControlLevel", "very_poorly_controlled", "derived")] },
      draftInput({ questionAnswers: [qa("T1-WorstControlLevel", "well_controlled", "derived")] }),
    );
    const d = (out.question_answers as Array<{ question_id: string; answer: unknown }>)
      .find((q) => q.question_id === "T1-WorstControlLevel");
    expect(d?.answer).toBe("well_controlled");
  });

  it("drops a stale derived value when the new draft has none", () => {
    // No event established a control level this time, so the engine computed
    // nothing. Carrying the old value forward would gate the comorbidity rule on
    // a control level the current annotations no longer support.
    const out = mergeAdherenceImport(
      { question_answers: [qa("T1-WorstControlLevel", "not_well_controlled", "derived")] },
      draftInput({ questionAnswers: [qa("Q1", true, "agent")] }),
    );
    expect((out.question_answers as Array<{ question_id: string }>)
      .some((q) => q.question_id === "T1-WorstControlLevel")).toBe(false);
  });

  it("but a reviewer CANNOT be overwritten by a derived answer of the same id", () => {
    // Defence in depth: nothing should ever commit a reviewer answer for a
    // derived id (it is not a question), and if something did, reviewer-win
    // still holds rather than the engine silently replacing a human's entry.
    const out = mergeAdherenceImport(
      { question_answers: [qa("T1-WorstControlLevel", "not_well_controlled", "reviewer")] },
      draftInput({ questionAnswers: [qa("T1-WorstControlLevel", "well_controlled", "derived")] }),
    );
    const d = (out.question_answers as Array<{ question_id: string; answer: unknown }>)
      .find((q) => q.question_id === "T1-WorstControlLevel");
    expect(d?.answer).toBe("not_well_controlled");
  });
});

describe("the Agent column shows the LATEST run", () => {
  it("agent_question_answers is replaced wholesale, not merged", () => {
    // Deliberate and load-bearing: the shadow is what the reviewer adjudicates
    // AGAINST, so it must be this run's answers and not an accumulation. The
    // earlier run's answers remain in var/runs, which is the immutable record.
    const out = mergeAdherenceImport(
      { agent_question_answers: { agent_1: [qa("Q1", "round-one", "agent")] } },
      draftInput({ agentQuestionAnswers: { agent_1: [qa("Q1", "round-two", "agent")] } }),
    );
    expect(out.agent_question_answers).toEqual({ agent_1: [qa("Q1", "round-two", "agent")] });
  });

  it("agent_rule_events MERGES per agent, so an agent silent this round keeps its shadow", () => {
    const out = mergeAdherenceImport(
      { agent_rule_events: { agent_1: [ev("e1")], agent_2: [ev("e2")] } },
      draftInput({
        ruleEvents: [ev("e1")],                      // event-bearing, so the branch runs
        agentRuleEvents: { agent_1: [ev("e1b")] },   // agent_2 produced nothing
      }),
    );
    const shadows = out.agent_rule_events as Record<string, RuleEvent[]>;
    expect(shadows.agent_1!.map((e) => e.event_id)).toEqual(["e1b"]);
    expect(shadows.agent_2!.map((e) => e.event_id)).toEqual(["e2"]);
  });
});
