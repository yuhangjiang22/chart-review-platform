import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TASK = {
  task_id: "chart-review-acts", task_kind: "phenotype" as const, source_document_sha: "x",
  fields: [{ id: "apoe4", answer_schema: { enum: ["1", "0", "NA"] } }],
};
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pn-edit-")); process.env.CHART_REVIEW_REVIEWS_ROOT = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_REVIEWS_ROOT; });

describe("reviewer edit is encounter-scoped", () => {
  it("editing n1/apoe4 does not clobber n2/apoe4 and captures the agent snapshot", async () => {
    const m = await import("./review-state.js");
    m.writePerNoteAssessments("p1", TASK as never, { noteId: "n1", fields: [{ field_id: "apoe4", answer: "0" }] });
    m.writePerNoteAssessments("p1", TASK as never, { noteId: "n2", fields: [{ field_id: "apoe4", answer: "1" }] });
    // reviewer overrides n1 → "1"
    m.applyUiAction("p1", TASK as never, "reviewer", "rev1", {
      type: "set_field_assessment",
      payload: { field_id: "apoe4", answer: "1", encounter_id: "n1" },
    });
    const state = m.load("p1", "chart-review-acts")!;
    const n1 = state.field_assessments.find((a) => a.encounter_id === "n1")!;
    const n2 = state.field_assessments.find((a) => a.encounter_id === "n2")!;
    expect(n1.answer).toBe("1");
    expect(n1.source).toBe("reviewer");
    expect(n1.original_agent_snapshot?.answer).toBe("0");
    expect(n2.answer).toBe("1");       // untouched
    expect(n2.source).toBe("agent");
    expect(state.field_assessments.length).toBe(2); // no duplicate created
  });
});
