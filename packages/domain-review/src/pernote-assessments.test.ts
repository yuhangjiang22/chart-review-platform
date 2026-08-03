import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TASK = {
  task_id: "chart-review-acts",
  task_kind: "phenotype" as const,
  source_document_sha: "x",
  fields: [
    { id: "impaired_cognition", answer_schema: { enum: ["1", "0"] } },
    { id: "apoe4", answer_schema: { enum: ["1", "0", "NA"] } },
  ],
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pernote-store-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = tmp;
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_REVIEWS_ROOT; });

describe("writePerNoteAssessments", () => {
  it("writes one Encounter per note and (field,encounter) assessments", async () => {
    const m = await import("./review-state.js");
    m.writePerNoteAssessments("p1", TASK as never, {
      noteId: "2026-02-10__memory_clinic", date: "2026-02-10", label: "memory_clinic",
      fields: [
        { field_id: "impaired_cognition", answer: "1", confidence: "high" },
        { field_id: "apoe4", answer: "1", confidence: "high" },
      ],
    });
    m.writePerNoteAssessments("p1", TASK as never, {
      noteId: "2026-03-01__followup", date: "2026-03-01", label: "followup",
      fields: [
        { field_id: "impaired_cognition", answer: "1", confidence: "medium" },
        { field_id: "apoe4", answer: "NA", confidence: "low" },
      ],
    });
    const state = m.load("p1", "chart-review-acts")!;
    expect(state.encounters?.map((e) => e.encounter_id).sort()).toEqual(["2026-02-10__memory_clinic", "2026-03-01__followup"]);
    expect(state.field_assessments.length).toBe(4);
    const byKey = new Map(state.field_assessments.map((a) => [`${a.field_id}::${a.encounter_id}`, a.answer]));
    expect(byKey.get("apoe4::2026-03-01__followup")).toBe("NA");
    expect(byKey.get("apoe4::2026-02-10__memory_clinic")).toBe("1");
    expect(state.field_assessments.every((a) => a.source === "agent" && a.status === "agent_proposed")).toBe(true);
  });

  it("re-writing the same note upserts in place (idempotent)", async () => {
    const m = await import("./review-state.js");
    const input = { noteId: "n1", fields: [{ field_id: "apoe4", answer: "0" as const }] };
    m.writePerNoteAssessments("p2", TASK as never, input);
    m.writePerNoteAssessments("p2", TASK as never, { noteId: "n1", fields: [{ field_id: "apoe4", answer: "1" }] });
    const state = m.load("p2", "chart-review-acts")!;
    expect(state.field_assessments.length).toBe(1);
    expect(state.field_assessments[0]!.answer).toBe("1");
    expect(state.encounters?.length).toBe(1);
  });
});
