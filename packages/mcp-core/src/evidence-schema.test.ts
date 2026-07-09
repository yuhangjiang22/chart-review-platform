import { describe, it, expect } from "vitest";
import { evidenceSchema } from "./index.js";

// Regression: LLM agents driven by JSON tool-calling serialize an absent
// optional field as an explicit `null`, not by omitting it. Zod's
// `.optional()` accepts `undefined` but REJECTS `null`, so every
// `set_field_assessment` whose evidence carried `unit: null` (a note quote has
// no unit) was rejected with a -32602 validation error. The agent could not
// commit a single field, never reached `set_review_status`, and the run
// produced no draft. Every optional evidence field must therefore tolerate
// null as well as undefined (`.nullish()`).
describe("evidenceSchema tolerates null on optional fields", () => {
  it("accepts a note-quote evidence with unit:null and other inapplicable nulls", () => {
    const ev = {
      source: "note",
      note_id: "n1",
      span_offsets: [10, 20],
      verbatim_quote: "acetaminophen 500 mg",
      unit: null, // ← the field that rejected the whole RUCAM run
      doc_type: null,
      author_role: null,
      evidence_date: null,
    };
    expect(() => evidenceSchema.parse(ev)).not.toThrow();
  });

  it("accepts omop lab evidence with a real unit + null string/number optionals", () => {
    const ev = {
      source: "omop",
      table: "measurement",
      row_id: "r42",
      concept_id: null,
      concept_name: null,
      value: 480,
      unit: "U/L",
    };
    expect(() => evidenceSchema.parse(ev)).not.toThrow();
  });

  it("accepts span_offsets:null (agent nulls an unused note field)", () => {
    expect(() =>
      evidenceSchema.parse({ source: "omop", table: "measurement", row_id: "r1", span_offsets: null }),
    ).not.toThrow();
  });

  it("still accepts a fully-omitted (undefined) evidence", () => {
    expect(() => evidenceSchema.parse({ source: "note" })).not.toThrow();
  });

  it("coerces a NUMERIC row_id to string (the -32602 hang bug)", () => {
    // Agents cite an OMOP row by its numeric row_id; the schema declared string,
    // so `row_id: 12345` was rejected → retry storm → deepagents hang.
    const parsed = evidenceSchema.parse({ source: "omop", table: "measurement", row_id: 12345 });
    expect(parsed.row_id).toBe("12345");
  });

  it("coerces other numeric scalar fields to string rather than rejecting", () => {
    const parsed = evidenceSchema.parse({ source: "note", note_id: 7, unit: 5 });
    expect(parsed.note_id).toBe("7");
    expect(parsed.unit).toBe("5");
  });
});
