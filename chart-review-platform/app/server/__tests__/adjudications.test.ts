// app/server/__tests__/adjudications.test.ts
import { describe, it, expect } from "vitest";
import { writeAdjudication, listAdjudications, splitByClassification, type Adjudication } from "../adjudications.js";
import fs from "fs";
import path from "path";
import os from "os";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "adj-"));

const adj = (overrides: Partial<Adjudication> = {}): Adjudication => ({
  patient_id: "p1",
  field_id: "C1",
  pair: { agent_a: "agent_1", agent_b: "agent_2" },
  classification: "guideline_gap",
  suggested_revision: "Make C1 more specific",
  reviewer: "test_user",
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe("adjudications", () => {
  it("writes and reads a single adjudication", () => {
    const dir = tmp();
    writeAdjudication(dir, adj());
    const all = listAdjudications(dir);
    expect(all).toHaveLength(1);
    expect(all[0].field_id).toBe("C1");
  });

  it("splitByClassification routes correctly", () => {
    const set = [
      adj({ classification: "guideline_gap", field_id: "C1" }),
      adj({ classification: "agent_a_error", field_id: "C2" }),
      adj({ classification: "agent_b_error", field_id: "C3" }),
      adj({ classification: "true_clinical_ambiguity", field_id: "C4" }),
    ];
    const s = splitByClassification(set);
    expect(s.guideline_gaps).toHaveLength(1);
    expect(s.agent_errors).toHaveLength(2);
    expect(s.clinical_ambiguities).toHaveLength(1);
  });

  it("requires suggested_revision when classification is guideline_gap", () => {
    expect(() => writeAdjudication(tmp(), adj({ classification: "guideline_gap", suggested_revision: "" })))
      .toThrow(/suggested_revision required/i);
  });
});
