import { describe, it, expect } from "vitest";
import { parseLabelResponse, fieldsFromTask, type PerNoteField } from "./index.js";

const FIELDS: PerNoteField[] = [
  { field_id: "impaired_cognition", enum: ["1", "0"], prompt: "cog?" },
  { field_id: "apoe4", enum: ["1", "0", "NA"], prompt: "apoe4?" },
];

describe("parseLabelResponse", () => {
  it("parses an object-keyed response and keeps only enum-valid answers", () => {
    const text = JSON.stringify({
      impaired_cognition: { answer: "1", confidence: "high", evidence_quote: "MCI documented", rationale: "MoCA 21" },
      apoe4: { answer: "1", confidence: "high", evidence_quote: "ε3/ε4", rationale: "carrier" },
    });
    const out = parseLabelResponse(text, FIELDS);
    expect(out.map((f) => [f.field_id, f.answer])).toEqual([
      ["impaired_cognition", "1"], ["apoe4", "1"],
    ]);
    expect(out[0]!.evidence_quote).toBe("MCI documented");
  });

  it("strips markdown fences and drops out-of-enum answers", () => {
    const text = "```json\n" + JSON.stringify({
      impaired_cognition: { answer: "MAYBE", confidence: "low", evidence_quote: "", rationale: "" },
      apoe4: { answer: "NA", confidence: "medium", evidence_quote: "no genotype", rationale: "absent" },
    }) + "\n```";
    const out = parseLabelResponse(text, FIELDS);
    expect(out.find((f) => f.field_id === "impaired_cognition")!.answer).toBeUndefined();
    expect(out.find((f) => f.field_id === "apoe4")!.answer).toBe("NA");
  });

  it("returns one entry per requested field even when the model omits some", () => {
    const out = parseLabelResponse(JSON.stringify({ apoe4: { answer: "0" } }), FIELDS);
    expect(out.map((f) => f.field_id).sort()).toEqual(["apoe4", "impaired_cognition"]);
    expect(out.find((f) => f.field_id === "impaired_cognition")!.answer).toBeUndefined();
  });
});

describe("fieldsFromTask", () => {
  it("includes leaf enum fields and EXCLUDES derived fields", () => {
    const task = {
      task_id: "acts",
      fields: [
        { id: "apoe_genotype", answer_schema: { enum: ["e3/e4", "none"] } },
        { id: "apoe4", answer_schema: { enum: ["1", "0", "NA"] }, derivation: 'apoe_genotype in ["e3/e4"] ? "1" : "NA"' },
        { id: "impaired_cognition", answer_schema: { enum: ["1", "0"] } },
        { id: "no_enum_field", answer_schema: {} },
      ],
    };
    const out = fieldsFromTask(task as never);
    // derived apoe4 excluded; no-enum field excluded; leaves kept
    expect(out.map((f) => f.field_id).sort()).toEqual(["apoe_genotype", "impaired_cognition"]);
  });
});
