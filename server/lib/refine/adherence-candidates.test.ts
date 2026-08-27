import { describe, it, expect } from "vitest";
import { buildAdherenceClusters, answersEqual, type AdherencePatientInput } from "./adherence-candidates.js";

describe("answersEqual", () => {
  it("normalizes string case + whitespace and undefined→null", () => {
    expect(answersEqual(" Yes ", "yes")).toBe(true);
    expect(answersEqual(undefined, null)).toBe(true);
    expect(answersEqual(20, 20)).toBe(true);
    expect(answersEqual("yes", "no")).toBe(false);
    expect(answersEqual(19, 20)).toBe(false);
    expect(answersEqual(true, "true")).toBe(false); // type-distinct
  });
});

describe("buildAdherenceClusters", () => {
  it("clusters per-question disagreements on validated questions only", () => {
    const patients: AdherencePatientInput[] = [
      {
        patient_id: "p1",
        validated_questions: ["T1-ACTScore", "T0-AsthmaDx"],
        human_answers: { "T1-ACTScore": 18, "T0-AsthmaDx": true, "T2-Step": "ICS" },
        human_evidence: { "T1-ACTScore": { note_id: "n1", quote: "ACT 18" } },
        agent_answers_by_agent: {
          agent_1: { "T1-ACTScore": 22, "T0-AsthmaDx": true, "T2-Step": "LABA" },
        },
      },
    ];
    const { clusters, n_validated_patients } = buildAdherenceClusters(patients);
    expect(n_validated_patients).toBe(1);
    // T1-ACTScore: 22 vs 18 → disagreement. T0-AsthmaDx: agree. T2-Step: NOT validated → ignored.
    expect([...clusters.keys()]).toEqual(["T1-ACTScore"]);
    const c = clusters.get("T1-ACTScore")!;
    expect(c.n_disagreements).toBe(1);
    expect(c.examples[0].agent_answer).toBe(22);
    expect(c.examples[0].reviewer_answer).toBe(18);
    expect(c.examples[0].excerpt).toBe("ACT 18");
  });

  it("ignores a question with no reviewer gold even if validated", () => {
    const { clusters } = buildAdherenceClusters([
      {
        patient_id: "p1",
        validated_questions: ["Q1"],
        human_answers: {}, // no gold
        agent_answers_by_agent: { a1: { Q1: "x" } },
      },
    ]);
    expect(clusters.size).toBe(0);
  });

  it("aggregates the same question's disagreements across agents", () => {
    const { clusters } = buildAdherenceClusters([
      {
        patient_id: "p1",
        validated_questions: ["Q1"],
        human_answers: { Q1: "yes" },
        agent_answers_by_agent: { a1: { Q1: "no" }, a2: { Q1: "maybe" } },
      },
    ]);
    expect(clusters.get("Q1")!.n_disagreements).toBe(2);
  });

  it("does not count patients with no validated questions", () => {
    const { n_validated_patients } = buildAdherenceClusters([
      { patient_id: "p1", validated_questions: [], human_answers: {}, agent_answers_by_agent: {} },
    ]);
    expect(n_validated_patients).toBe(0);
  });

  it("gold_by_question spans ALL validated patients; examplePatientFilter restricts only examples", () => {
    const patients: AdherencePatientInput[] = [
      { patient_id: "refine1", validated_questions: ["Q1"], human_answers: { Q1: "yes" }, agent_answers_by_agent: { a1: { Q1: "no" } } },
      { patient_id: "held1", validated_questions: ["Q1"], human_answers: { Q1: "yes" }, agent_answers_by_agent: { a1: { Q1: "no" } } },
    ];
    const { clusters, gold_by_question } = buildAdherenceClusters(patients, new Set(["refine1"]));
    // gold spans both patients
    expect(Object.keys(gold_by_question.Q1).sort()).toEqual(["held1", "refine1"]);
    // but only refine1's disagreement is emitted as an example
    expect(clusters.get("Q1")!.examples.map((e) => e.patient_id)).toEqual(["refine1"]);
  });
});

describe("gold outlives the rubric", () => {
  // Reviewer gold is whatever a human validated, and it can outlive the question:
  // a question deleted in a later rubric version still sits in old review_states.
  // Measured on a real session — T1-ControllerAdherenceProxy, gone from the
  // rubric, still present in gold and still forming a cluster with no text, no
  // retrieval_hints and no enum. The proposer would then be asked to append
  // guidance to a question that no longer exists.
  const patient = (over: Partial<AdherencePatientInput> = {}): AdherencePatientInput => ({
    patient_id: "p1",
    validated_questions: ["T1-Live", "T1-Retired"],
    human_answers: { "T1-Live": "a", "T1-Retired": "x" },
    agent_answers_by_agent: { agent_1: { "T1-Live": "b", "T1-Retired": "y" } },
    ...over,
  });

  it("a retired question still clusters at the build step — it is not filtered here", () => {
    // buildAdherenceClusters has no rubric to consult; the drop happens where the
    // question definitions are joined. Pinned so the two halves stay honest about
    // which one owns the filter.
    const { clusters, gold_by_question } = buildAdherenceClusters([patient()]);
    expect([...clusters.keys()].sort()).toEqual(["T1-Live", "T1-Retired"]);
    expect(Object.keys(gold_by_question).sort()).toEqual(["T1-Live", "T1-Retired"]);
  });

  it("gold for a retired question is dropped, not just its cluster", () => {
    // The held-out re-score reads gold_by_question. Leaving the entry there would
    // score a held-out patient on a question the current rubric cannot ask.
    const { clusters, gold_by_question } = buildAdherenceClusters([patient()]);
    const defs = new Map([["T1-Live", { text: "t", retrieval_hints: null, tier: 1, answer_enum: null }]]);
    const retired = [...new Set([...clusters.keys(), ...Object.keys(gold_by_question)])]
      .filter((q) => !defs.has(q)).sort();
    for (const q of retired) { clusters.delete(q); delete gold_by_question[q]; }

    expect(retired).toEqual(["T1-Retired"]);
    expect([...clusters.keys()]).toEqual(["T1-Live"]);
    expect(Object.keys(gold_by_question)).toEqual(["T1-Live"]);
  });
});
