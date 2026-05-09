// app/server/__tests__/disagreements.test.ts
import { describe, it, expect } from "vitest";
import { compareDrafts, type AgentDraft, type Disagreement } from "../disagreements.js";

const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
  agent_id: "agent_1",
  patient_id: "p1",
  field_assessments: [],
  ...overrides,
});

describe("compareDrafts", () => {
  it("flags hard mismatch as disagreement", () => {
    const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [] }] });
    const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "no", evidence: [] }] });
    const d = compareDrafts([a, b]);
    expect(d.disagreements).toHaveLength(1);
    expect(d.disagreements[0].kind).toBe("hard");
    expect(d.disagreements[0].field_id).toBe("C1");
  });

  it("flags soft mismatch (yes vs no_info)", () => {
    const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [] }] });
    const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "no_info", evidence: [] }] });
    const d = compareDrafts([a, b]);
    expect(d.disagreements).toHaveLength(1);
    expect(d.disagreements[0].kind).toBe("soft");
  });

  it("does NOT flag agreement on answer with same evidence", () => {
    const ev = [{ note_id: "n1", verbatim_quote: "x", span_offsets: [0, 1] as [number, number] }];
    const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: ev }] });
    const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "yes", evidence: ev }] });
    const d = compareDrafts([a, b]);
    expect(d.disagreements).toHaveLength(0);
    expect(d.same_answer_different_evidence_count).toBe(0);
  });

  it("counts same-answer-different-evidence (does NOT queue it)", () => {
    const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [{ note_id: "n1", verbatim_quote: "alpha", span_offsets: [0, 5] }] }] });
    const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [{ note_id: "n2", verbatim_quote: "beta", span_offsets: [10, 14] }] }] });
    const d = compareDrafts([a, b]);
    expect(d.disagreements).toHaveLength(0);
    expect(d.same_answer_different_evidence_count).toBe(1);
  });

  it("treats missing field_assessment as no_info (soft mismatch vs yes)", () => {
    const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [] }] });
    const b = draft({ agent_id: "b", field_assessments: [] });
    const d = compareDrafts([a, b]);
    expect(d.disagreements).toHaveLength(1);
    expect(d.disagreements[0].kind).toBe("soft");
  });

  it("emits pairwise disagreements for N=3", () => {
    const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [] }] });
    const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "no", evidence: [] }] });
    const c = draft({ agent_id: "c", field_assessments: [{ field_id: "C1", answer: "no_info", evidence: [] }] });
    const d = compareDrafts([a, b, c]);
    // a-b hard, a-c soft, b-c soft → 3 pairs
    expect(d.disagreements).toHaveLength(3);
  });

  it("groups by criterion in summary", () => {
    const a = draft({ agent_id: "a", field_assessments: [
      { field_id: "C1", answer: "yes", evidence: [] },
      { field_id: "C2", answer: "yes", evidence: [] },
    ]});
    const b = draft({ agent_id: "b", field_assessments: [
      { field_id: "C1", answer: "no", evidence: [] },
      { field_id: "C2", answer: "yes", evidence: [] },
    ]});
    const d = compareDrafts([a, b]);
    expect(d.by_criterion.C1.disagreement_count).toBe(1);
    expect(d.by_criterion.C2).toBeUndefined(); // agreed → no entry
  });

  it("treats false (boolean) and 'false' (string) as same answer (no disagreement)", () => {
    const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: false, evidence: [] }] });
    const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "false", evidence: [] }] });
    const d = compareDrafts([a, b]);
    expect(d.disagreements).toHaveLength(0);
  });

  it("treats null and 'null' as same answer", () => {
    const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: null, evidence: [] }] });
    const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "null", evidence: [] }] });
    const d = compareDrafts([a, b]);
    expect(d.disagreements).toHaveLength(0);
  });

  it("structured-data evidence (no note_id) gets fingerprinted by table+row_id", () => {
    const ev1 = [{ source: "omop", table: "condition_occurrence", row_id: 5102, concept_id: 4193869 }];
    const ev2 = [{ source: "omop", table: "condition_occurrence", row_id: 9999, concept_id: 4193869 }];
    const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "true", evidence: ev1 }] });
    const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "true", evidence: ev2 }] });
    const d = compareDrafts([a, b]);
    // Same answer, different evidence rows → counted but not a disagreement
    expect(d.disagreements).toHaveLength(0);
    expect(d.same_answer_different_evidence_count).toBe(1);
  });

  it("compareDrafts compares all input drafts pairwise (caller responsible for grouping)", () => {
    // Same agent_id but two patients — compareDrafts will cross-compare them.
    // This documents the contract: callers must group by patient before calling.
    const a = draft({ agent_id: "agent_1", patient_id: "p1", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [] }] });
    const b = draft({ agent_id: "agent_1", patient_id: "p2", field_assessments: [{ field_id: "C1", answer: "no", evidence: [] }] });
    const d = compareDrafts([a, b]);
    // Demonstrates the cross-pair behavior — caller must filter.
    expect(d.disagreements).toHaveLength(1);
  });
});
