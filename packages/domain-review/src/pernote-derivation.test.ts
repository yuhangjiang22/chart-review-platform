import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APOE4_DERIV =
  'apoe_genotype in ["e2/e4","e3/e4","e4/e4","e4_carrier"] ? "1" : apoe_genotype in ["e2/e2","e2/e3","e3/e3"] ? "0" : "NA"';
const TASK = {
  task_id: "acts",
  task_kind: "phenotype" as const,
  source_document_sha: "x",
  fields: [
    { id: "apoe_genotype", answer_schema: { enum: ["e3/e4", "e4/e4", "none"] } },
    { id: "apoe4", answer_schema: { enum: ["1", "0", "NA"] }, derivation: APOE4_DERIV },
  ],
};

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pn-deriv-")); process.env.CHART_REVIEW_REVIEWS_ROOT = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_REVIEWS_ROOT; });

describe("encounter-aware derivation recompute", () => {
  it("derives apoe4 PER NOTE from each note's genotype", async () => {
    const m = await import("./review-state.js");
    m.writePerNoteAssessments("p1", TASK as never, { noteId: "n1", fields: [{ field_id: "apoe_genotype", answer: "e3/e4" }] });
    m.writePerNoteAssessments("p1", TASK as never, { noteId: "n2", fields: [{ field_id: "apoe_genotype", answer: "none" }] });
    const s = m.load("p1", "acts")!;
    const get = (fid: string, enc: string | undefined) =>
      s.field_assessments.find((a) => a.field_id === fid && a.encounter_id === enc);
    expect(get("apoe4", "n1")?.answer).toBe("1");      // e3/e4 → ε4 present
    expect(get("apoe4", "n1")?.source).toBe("derived");
    expect(get("apoe4", "n2")?.answer).toBe("NA");     // none → not determinable
    // no patient-level (undefined-encounter) apoe4 leaked
    expect(s.field_assessments.filter((a) => a.field_id === "apoe4" && a.encounter_id === undefined).length).toBe(0);
  });

  it("still derives PATIENT-LEVEL (undefined encounter) when leaves are patient-scoped", async () => {
    const m = await import("./review-state.js");
    m.applyUiAction("p3", TASK as never, "agent", "a", {
      type: "set_field_assessment",
      payload: { field_id: "apoe_genotype", answer: "e4/e4" },
    });
    const s = m.load("p3", "acts")!;
    const a4 = s.field_assessments.find((a) => a.field_id === "apoe4");
    expect(a4?.answer).toBe("1");
    expect(a4?.encounter_id).toBeUndefined();
  });
});

const SEV_TASK = {
  task_id: "acts", task_kind: "phenotype" as const, source_document_sha: "x",
  fields: [
    { id: "moca_score", answer_schema: { type: "integer", minimum: 0, maximum: 30 } },
    {
      id: "moca_severity",
      answer_schema: { enum: ["normal", "mild", "moderate", "severe"] },
      derivation: 'moca_score >= 26 ? "normal" : moca_score >= 18 ? "mild" : moca_score >= 10 ? "moderate" : "severe"',
    },
  ],
};

describe("derived severity does not cascade from an ABSENT score", () => {
  it("does NOT fabricate 'severe' when moca_score is null (the real-data bug)", async () => {
    const m = await import("./review-state.js");
    m.applyUiAction("ps1", SEV_TASK as never, "reviewer", "r", {
      type: "set_field_assessment", payload: { field_id: "moca_score", answer: null },
    });
    const sev = m.load("ps1", "acts")!.field_assessments.find((a) => a.field_id === "moca_severity");
    expect(sev?.answer ?? null).toBeNull(); // Pending, not a bogus "severe"
  });
  it("DOES derive the correct band from a real score", async () => {
    const m = await import("./review-state.js");
    m.applyUiAction("ps2", SEV_TASK as never, "reviewer", "r", {
      type: "set_field_assessment", payload: { field_id: "moca_score", answer: 8 },
    });
    expect(m.load("ps2", "acts")!.field_assessments.find((a) => a.field_id === "moca_severity")?.answer).toBe("severe");
    m.applyUiAction("ps3", SEV_TASK as never, "reviewer", "r", {
      type: "set_field_assessment", payload: { field_id: "moca_score", answer: 28 },
    });
    expect(m.load("ps3", "acts")!.field_assessments.find((a) => a.field_id === "moca_severity")?.answer).toBe("normal");
  });
});
