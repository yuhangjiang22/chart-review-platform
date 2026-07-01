import { describe, it, expect } from "vitest";
import {
  hashSpan,
  mapStatus,
  buildSpanLabel,
  groupByPerson,
  assertOffsetsFaithful,
  buildReviewState,
} from "./benchmark-ner-map.js";

describe("hashSpan", () => {
  it("matches the platform algorithm (sha256 of note|start|end|type, first 16 hex)", () => {
    const id = hashSpan("68324", 10, 20, "Demographic");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toBe(hashSpan("68324", 11, 20, "Demographic"));
    expect(id).toBe(hashSpan("68324", 10, 20, "Demographic"));
  });
});

describe("mapStatus", () => {
  it("folds mapped_uncertain into mapped and passes novel_candidate through", () => {
    expect(mapStatus("mapped")).toBe("mapped");
    expect(mapStatus("mapped_uncertain")).toBe("mapped");
    expect(mapStatus("novel_candidate")).toBe("novel_candidate");
  });
});

describe("buildSpanLabel", () => {
  it("maps a benchmark entity to a platform SpanLabel with computed span_id + provenance", () => {
    const ent = {
      text: "Tobacco use", start: 2738, end: 2749,
      entity_type: "Element_Relevant_to_Behavior_and_Lifestyle",
      concept_name: "Tobacco_Use", status: "mapped" as const,
      match_kind: "mapped_underscore_normalized",
    };
    const s = buildSpanLabel("81117", ent);
    expect(s.span_id).toBe(hashSpan("81117", 2738, 2749, "Element_Relevant_to_Behavior_and_Lifestyle"));
    expect(s.note_id).toBe("81117");
    expect(s.text).toBe("Tobacco use");
    expect(s.anchor).toBe("Tobacco use");
    expect(s.concept_name).toBe("Tobacco_Use");
    expect(s.status).toBe("mapped");
    expect(s.proposed_by).toEqual(["benchmark-gpt-5.2"]);
    expect(s.override_reason).toBe("match_kind=mapped_underscore_normalized");
  });

  it("empty concept_name + novel_candidate carries through", () => {
    const ent = { text: "Z72.0", start: 3930, end: 3935, entity_type: "X", concept_name: "", status: "novel_candidate" as const, match_kind: "novel_candidate_none" };
    const s = buildSpanLabel("81117", ent);
    expect(s.status).toBe("novel_candidate");
    expect(s.concept_name).toBe("");
  });
});

describe("groupByPerson", () => {
  it("groups note_ids under their person_id", () => {
    const preds = {
      "68324": { person_id: "p1", entities: [] },
      "75324": { person_id: "p2", entities: [] },
      "99999": { person_id: "p1", entities: [] },
    };
    expect(groupByPerson(preds)).toEqual({ p1: ["68324", "99999"], p2: ["75324"] });
  });
});

describe("assertOffsetsFaithful", () => {
  it("passes when source[start:end] === text", () => {
    expect(() => assertOffsetsFaithful("abcTobacco", [{ text: "Tobacco", start: 3, end: 10 } as any], "n1")).not.toThrow();
  });
  it("throws on a mismatch", () => {
    expect(() => assertOffsetsFaithful("abc", [{ text: "X", start: 0, end: 1 } as any], "n1")).toThrow(/offset/i);
  });
});

describe("buildReviewState", () => {
  it("produces a NER ReviewState with all required fields populated", () => {
    const spans = [buildSpanLabel("68324", { text: "Smoker", start: 0, end: 6, entity_type: "X", concept_name: "Tobacco_Use", status: "mapped" })];
    const rs = buildReviewState("patient_real_p1", "chart-review-bso-ad-ner", spans, "2026-06-30T00:00:00.000Z", "bso-ad@2026.05.28-0");
    expect(rs.schema_version).toBe("1");
    expect(rs.patient_id).toBe("patient_real_p1");
    expect(rs.task_id).toBe("chart-review-bso-ad-ner");
    expect(rs.task_kind).toBe("ner");
    expect(rs.review_status).toBe("agent_complete");
    expect(rs.version).toBe(1);
    expect(rs.updated_by).toBe("agent");
    expect(rs.field_assessments).toEqual([]);
    expect(rs.span_labels).toHaveLength(1);
    expect(rs.validated_notes).toEqual([]);
    expect(rs.ontology_pin).toBe("bso-ad@2026.05.28-0");
  });
});
