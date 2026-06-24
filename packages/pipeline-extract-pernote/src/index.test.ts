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

describe("parseLabelResponse — numeric + free-text fields", () => {
  const FIELDS2: PerNoteField[] = [
    { field_id: "moca_score", enum: [], type: "integer", min: 0, max: 30, prompt: "MoCA?" },
    { field_id: "lmp_date", enum: [], type: "string", prompt: "LMP?" },
  ];

  it("keeps an in-range numeric answer AS A NUMBER", () => {
    const out = parseLabelResponse(JSON.stringify({ moca_score: { answer: 21 }, lmp_date: { answer: "05/10/2026" } }), FIELDS2);
    const moca = out.find((f) => f.field_id === "moca_score")!;
    expect(moca.answer).toBe(21);
    expect(typeof moca.answer).toBe("number");
    expect(out.find((f) => f.field_id === "lmp_date")!.answer).toBe("05/10/2026");
  });

  it("coerces a numeric string ('21') to a number", () => {
    const out = parseLabelResponse(JSON.stringify({ moca_score: { answer: "21" } }), FIELDS2);
    expect(out.find((f) => f.field_id === "moca_score")!.answer).toBe(21);
  });

  it("drops an out-of-range or non-numeric numeric answer", () => {
    const hi = parseLabelResponse(JSON.stringify({ moca_score: { answer: 35 } }), FIELDS2);
    expect(hi.find((f) => f.field_id === "moca_score")!.answer).toBeUndefined();
    const nan = parseLabelResponse(JSON.stringify({ moca_score: { answer: "not a score" } }), FIELDS2);
    expect(nan.find((f) => f.field_id === "moca_score")!.answer).toBeUndefined();
  });

  it("drops an empty free-text answer", () => {
    const out = parseLabelResponse(JSON.stringify({ lmp_date: { answer: "" } }), FIELDS2);
    expect(out.find((f) => f.field_id === "lmp_date")!.answer).toBeUndefined();
  });
});

describe("fieldsFromTask", () => {
  it("includes enum, numeric, and free-text leaves; EXCLUDES derived + untyped", () => {
    const task = {
      task_id: "acts",
      fields: [
        { id: "apoe_genotype", answer_schema: { enum: ["e3/e4", "none"] } },
        { id: "apoe4", answer_schema: { enum: ["1", "0", "NA"] }, derivation: 'apoe_genotype in ["e3/e4"] ? "1" : "NA"' },
        { id: "impaired_cognition", answer_schema: { enum: ["1", "0"] } },
        { id: "moca_score", answer_schema: { type: "integer", minimum: 0, maximum: 30 } },
        { id: "lmp_date", answer_schema: { type: "string" } },
        { id: "no_schema_field", answer_schema: {} },
      ],
    };
    const out = fieldsFromTask(task as never);
    // derived apoe4 excluded; untyped no_schema_field excluded; rest kept
    expect(out.map((f) => f.field_id).sort()).toEqual(["apoe_genotype", "impaired_cognition", "lmp_date", "moca_score"]);
    const moca = out.find((f) => f.field_id === "moca_score")!;
    expect(moca.type).toBe("integer");
    expect(moca.min).toBe(0);
    expect(moca.max).toBe(30);
  });
});
