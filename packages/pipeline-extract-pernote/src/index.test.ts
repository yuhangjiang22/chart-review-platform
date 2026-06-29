import { describe, it, expect } from "vitest";
import {
  parseLabelResponse, fieldsFromTask, tryParseLabelJson, callWithTruncationRetry,
  numericValueInNote,
  type PerNoteField,
} from "./index.js";
import type { LlmEndpoint, LlmResult } from "@chart-review/pipeline-extract-ner";

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

describe("parseLabelResponse — entity-list (array) fields", () => {
  const ALLERGEN: PerNoteField[] = [
    {
      field_id: "allergen", enum: [], type: "array",
      entity: { value_key: "Allergen", attributes: { Category: { enum: ["medication", "food", "environment", "biologic"] }, Reaction: {} } },
    },
  ];
  it("keeps records with value + Supporting_Evidence; preserves valid attrs", () => {
    const text = JSON.stringify({
      allergen: { answer: [
        { Allergen: "penicillin", Category: "medication", Reaction: "rash", Supporting_Evidence: "allergic to penicillin (rash)" },
        { Allergen: "sulfa drugs", Category: "medication", Supporting_Evidence: "sulfa allergy" },
      ] },
    });
    const out = parseLabelResponse(text, ALLERGEN);
    const a = out[0]!.answer as Array<Record<string, unknown>>;
    expect(Array.isArray(a)).toBe(true);
    expect(a.length).toBe(2);
    expect(a[0]).toMatchObject({ Allergen: "penicillin", Category: "medication", Reaction: "rash" });
  });
  it("drops a record missing the value or Supporting_Evidence, and drops off-enum attrs", () => {
    const text = JSON.stringify({
      allergen: { answer: [
        { Allergen: "penicillin", Category: "lunar", Supporting_Evidence: "penicillin allergy" }, // off-enum Category dropped
        { Category: "food", Supporting_Evidence: "x" },          // no value → dropped
        { Allergen: "shellfish" },                                // no evidence → dropped
      ] },
    });
    const a = parseLabelResponse(text, ALLERGEN)[0]!.answer as Array<Record<string, unknown>>;
    expect(a.length).toBe(1);
    expect(a[0]!.Allergen).toBe("penicillin");
    expect(a[0]!.Category).toBeUndefined(); // off-enum attr dropped
  });
  it("yields [] for an empty list (none documented / NKDA)", () => {
    const a = parseLabelResponse(JSON.stringify({ allergen: { answer: [] } }), ALLERGEN)[0]!.answer;
    expect(a).toEqual([]);
  });
});

describe("fieldsFromTask — entity field", () => {
  it("captures type:array + the entity spec (value_key + attribute enums)", () => {
    const task = { task_id: "acts", fields: [
      { id: "allergen", answer_schema: { type: "array", entity: { value_key: "Allergen", attributes: { Category: { enum: ["medication", "food"] }, Reaction: {} } } } },
    ] };
    const f = fieldsFromTask(task as never).find((x) => x.field_id === "allergen")!;
    expect(f.type).toBe("array");
    expect(f.entity?.value_key).toBe("Allergen");
    expect(f.entity?.attributes.Category.enum).toEqual(["medication", "food"]);
    expect(f.entity?.attributes.Reaction.enum).toBeUndefined();
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

describe("tryParseLabelJson", () => {
  it("parses a JSON object / array / fenced block", () => {
    expect(tryParseLabelJson('{"a":{"answer":1}}')).toEqual({ a: { answer: 1 } });
    expect(tryParseLabelJson("[]")).toEqual([]);
    expect(tryParseLabelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParseLabelJson("{}")).toEqual({}); // legit "nothing documented" — NOT a failure
  });
  it("returns undefined for truncated / empty / non-JSON text", () => {
    expect(tryParseLabelJson('{"a":{"answer": 1, "evidence_quote": "the patient wa')).toBeUndefined(); // cut off mid-stream
    expect(tryParseLabelJson("")).toBeUndefined();
    expect(tryParseLabelJson("   ")).toBeUndefined();
    expect(tryParseLabelJson("I could not find anything.")).toBeUndefined();
  });
});

const EP: LlmEndpoint = { baseUrl: "x", apiKey: "x", model: "m", mode: "openrouter" };
/** A `call` stand-in returning a scripted sequence of results; records the
 *  maxTokens passed on each invocation so we can assert the retry escalates. */
function scriptedCall(results: Array<LlmResult | Error>) {
  const budgets: number[] = [];
  let i = 0;
  const fn = async (_ep: LlmEndpoint, _s: string, _u: string, maxTokens?: number): Promise<LlmResult> => {
    budgets.push(maxTokens ?? -1);
    const r = results[Math.min(i++, results.length - 1)]!;
    if (r instanceof Error) throw r;
    return r;
  };
  return Object.assign(fn, { budgets });
}

describe("callWithTruncationRetry — truncated/unparseable notes never silently drop", () => {
  it("good first response → 1 attempt, no retry, no error", async () => {
    const call = scriptedCall([{ text: '{"impaired_cognition":{"answer":"1"}}' }]);
    const out = await callWithTruncationRetry(call, EP, "sys", "usr");
    expect(out.attempts).toBe(1);
    expect(out.error).toBeUndefined();
    expect(out.res?.text).toContain("impaired_cognition");
    expect(call.budgets.length).toBe(1);
  });

  it("truncated first response → retries with a LARGER budget and recovers", async () => {
    const call = scriptedCall([
      { text: '{"a":{"answer":1', truncated: true }, // cut off
      { text: '{"impaired_cognition":{"answer":"0"}}' }, // full on retry
    ]);
    const out = await callWithTruncationRetry(call, EP, "sys", "usr", 8192, 16384);
    expect(out.attempts).toBe(2);
    expect(out.error).toBeUndefined();
    expect(call.budgets).toEqual([8192, 16384]); // retry escalated the budget
  });

  it("unparseable-but-not-flagged first response also triggers the retry", async () => {
    const call = scriptedCall([
      { text: "Sorry, here is the answer: impaired" }, // prose, no truncated flag
      { text: "{}" }, // valid empty on retry
    ]);
    const out = await callWithTruncationRetry(call, EP, "sys", "usr");
    expect(out.attempts).toBe(2);
    expect(out.error).toBeUndefined();
  });

  it("REGRESSION: still truncated after retry → surfaces an ERROR, not an empty parse", async () => {
    const call = scriptedCall([
      { text: '{"a":{"answer":1', truncated: true, usage: { output_tokens: 8192 } },
      { text: '{"a":{"answer":1, "evidence_quote":"the pat', truncated: true, usage: { output_tokens: 16384 } },
    ]);
    const out = await callWithTruncationRetry(call, EP, "sys", "usr");
    expect(out.attempts).toBe(2);
    expect(out.error).toBeDefined();
    expect(out.error).toMatch(/truncated|unparseable/i);
  });

  it("call throws on the first pass → LLM-call error surfaced", async () => {
    const call = scriptedCall([new Error("429 rate limited")]);
    const out = await callWithTruncationRetry(call, EP, "sys", "usr");
    expect(out.attempts).toBe(1);
    expect(out.error).toMatch(/LLM call failed.*429/);
  });
});

describe("numericValueInNote — numeric value must appear in the NOTE (no computed/inferred numbers)", () => {
  it("keeps a value written anywhere in the note (even if the model's quote was imperfect)", () => {
    expect(numericValueInNote(24, "...MMSE 24/30 today...")).toBe(true);
    expect(numericValueInNote(40, "long social hx; smoked for 40 years; ...")).toBe(true);
    expect(numericValueInNote(0.5, "tobacco: 0.5 ppd")).toBe(true);
    // REAL documented value whose cited span happened to be elsewhere is still kept:
    expect(numericValueInNote(30, "PMH ... 30 pack-year history ... assorted")).toBe(true);
  });

  it("DROPS a value computed from ages — the derived number is not in the note", () => {
    // note contains the two ages (20, 50) but NOT the derived duration 30
    expect(numericValueInNote(30, "started smoking at 20, quit at 50")).toBe(false);
  });

  it("does not match a value as a substring of another number", () => {
    expect(numericValueInNote(5, "quit at 50")).toBe(false);
    expect(numericValueInNote(2, "25 pack-year history")).toBe(false);
  });

  it("not grounded against an empty note", () => {
    expect(numericValueInNote(30, "")).toBe(false);
  });
});
