import { describe, it, expect } from "vitest";
import { DerivedAdjudicationSchema } from "../derived-adjudications/schema.js";

describe("DerivedAdjudicationSchema", () => {
  const baseRecord = {
    patient_id: "p1",
    field_id: "C1",
    iter_id: "iter-1",
    agent_1: {
      answer_match_human: false,
      evidence_overlap_jaccard: 0.5,
      notes_read_jaccard: 0.7,
      human_evidence_seen_by_agent: true,
      classification: "wrong_answer_clear_rule",
      rationale_short: "Agent answered yes; human truth is no.",
    },
    agent_2: {
      answer_match_human: true,
      evidence_overlap_jaccard: 1.0,
      notes_read_jaccard: 1.0,
      human_evidence_seen_by_agent: true,
      classification: "correct",
      rationale_short: "Match.",
    },
    pair: { classification: "one_wrong" },
    gap_signal: { candidate: false, reason: "agents converged after rerun", suggested_revision: null },
    trajectory_features: {
      notes_unique_to_agent_1: ["n3"],
      notes_unique_to_agent_2: [],
      notes_only_human_cited: ["n7"],
    },
    reviewer_comment: null,
    classifier: {
      model: "claude-haiku-4-5",
      ts: new Date().toISOString(),
      cost_usd: 0.001,
    },
  };

  it("accepts a valid record", () => {
    const parsed = DerivedAdjudicationSchema.parse(baseRecord);
    expect(parsed.patient_id).toBe("p1");
  });

  it("rejects an unknown agent classification", () => {
    expect(() =>
      DerivedAdjudicationSchema.parse({
        ...baseRecord,
        agent_1: { ...baseRecord.agent_1, classification: "nonsense" },
      }),
    ).toThrow();
  });

  it("rejects a Jaccard outside [0, 1]", () => {
    expect(() =>
      DerivedAdjudicationSchema.parse({
        ...baseRecord,
        agent_1: { ...baseRecord.agent_1, evidence_overlap_jaccard: 1.5 },
      }),
    ).toThrow();
  });
});
