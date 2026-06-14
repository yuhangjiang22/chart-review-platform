import { describe, it, expect } from "vitest";
import { buildNerClusters, pairToExample, type NerPatientInput } from "./ner-candidates.js";
import type { SpanLabel } from "@chart-review/platform-types";

// Minimal SpanLabel builder — computeSpanIaa keys on
// (note_id, start, end, entity_type, concept_name).
function span(over: Partial<SpanLabel> & { start: number; end: number; entity_type: string }): SpanLabel {
  return {
    span_id: `${over.note_id ?? "n1"}:${over.start}:${over.end}:${over.entity_type}`,
    note_id: over.note_id ?? "n1",
    text: over.text ?? "x",
    anchor: over.anchor ?? "x",
    start: over.start,
    end: over.end,
    entity_type: over.entity_type,
    concept_name: over.concept_name ?? "",
    status: over.status ?? "mapped",
  } as SpanLabel;
}

describe("buildNerClusters", () => {
  it("buckets over/under/concept disagreements by entity_type", () => {
    // human gold: keeps A (0-5, conceptA) + B (10-15, conceptB)
    const human = [
      span({ note_id: "n1", start: 0, end: 5, entity_type: "Demographic", concept_name: "Age", text: "67" }),
      span({ note_id: "n1", start: 10, end: 15, entity_type: "Demographic", concept_name: "Female", text: "woman" }),
      span({ note_id: "n1", start: 20, end: 25, entity_type: "Demographic", concept_name: "Married", text: "spouse" }),
    ];
    // agent: keeps A (agree), MISSES B, gets the 20-25 concept WRONG (Single not Married),
    // and OVER-EXTRACTS a 30-35 span the human didn't keep.
    const agent = [
      span({ note_id: "n1", start: 0, end: 5, entity_type: "Demographic", concept_name: "Age", text: "67" }),
      span({ note_id: "n1", start: 20, end: 25, entity_type: "Demographic", concept_name: "Single", text: "spouse" }),
      span({ note_id: "n1", start: 30, end: 35, entity_type: "Demographic", concept_name: "Race", text: "white" }),
    ];
    const input: NerPatientInput[] = [
      { patient_id: "p1", validated_notes: ["n1"], human_spans: human, agent_spans_by_agent: { agent_1: agent } },
    ];
    const { clusters, n_validated_patients, n_validated_notes } = buildNerClusters(input);
    expect(n_validated_patients).toBe(1);
    expect(n_validated_notes).toBe(1);
    const c = clusters.get("Demographic")!;
    expect(c).toBeTruthy();
    expect(c.n_over_extraction).toBe(1); // 30-35
    expect(c.n_under_extraction).toBe(1); // 10-15 missed
    expect(c.n_concept_mismatch).toBe(1); // 20-25 Single vs Married
    // the agree (0-5) is not an example
    expect(c.examples).toHaveLength(3);
    const over = c.examples.find((e) => e.kind === "over_extraction")!;
    expect(over.agent_text).toBe("white");
    expect(over.human_text).toBeNull();
    const under = c.examples.find((e) => e.kind === "under_extraction")!;
    expect(under.human_concept).toBe("Female");
    expect(under.agent_text).toBeNull();
    const concept = c.examples.find((e) => e.kind === "concept_mismatch")!;
    expect(concept.agent_concept).toBe("Single");
    expect(concept.human_concept).toBe("Married");
  });

  it("produces no examples when agent matches human exactly", () => {
    const spans = [span({ note_id: "n1", start: 0, end: 5, entity_type: "Demographic", concept_name: "Age" })];
    const { clusters } = buildNerClusters([
      { patient_id: "p1", validated_notes: ["n1"], human_spans: spans, agent_spans_by_agent: { a1: [...spans] } },
    ]);
    expect(clusters.size).toBe(0);
  });

  it("counts validated patients only when they have validated notes", () => {
    const { n_validated_patients } = buildNerClusters([
      { patient_id: "p1", validated_notes: [], human_spans: [], agent_spans_by_agent: {} },
    ]);
    expect(n_validated_patients).toBe(0);
  });

  it("aggregates examples across multiple agents into one entity-type cluster", () => {
    const human = [span({ note_id: "n1", start: 0, end: 5, entity_type: "Food", concept_name: "Hunger" })];
    const agentMiss = {}; // agent_1 has nothing → under_extraction
    const { clusters } = buildNerClusters([
      {
        patient_id: "p1",
        validated_notes: ["n1"],
        human_spans: human,
        agent_spans_by_agent: { agent_1: [], agent_2: [] },
      },
    ]);
    void agentMiss;
    const c = clusters.get("Food")!;
    expect(c.n_under_extraction).toBe(2); // both agents missed it
  });
});

describe("pairToExample", () => {
  it("returns null for an agree pair", () => {
    expect(pairToExample({ kind: "agree", note_id: "n1", entity_type: "X", a: null, b: null }, "p1", "a1")).toBeNull();
  });
  it("maps type_diff to type_mismatch", () => {
    const a = span({ note_id: "n1", start: 0, end: 3, entity_type: "Food", concept_name: "c" });
    const b = span({ note_id: "n1", start: 0, end: 3, entity_type: "Demographic", concept_name: "c" });
    const ex = pairToExample({ kind: "type_diff", note_id: "n1", entity_type: "Food", a, b }, "p1", "a1");
    expect(ex?.kind).toBe("type_mismatch");
    expect(ex?.agent_entity_type).toBe("Food");
    expect(ex?.human_entity_type).toBe("Demographic");
  });
});
