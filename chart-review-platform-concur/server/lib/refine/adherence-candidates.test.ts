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
});
