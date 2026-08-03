import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
function writeState(sid: string, pid: string, tid: string, state: unknown) {
  const dir = path.join(tmp, sid, pid, tid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify(state));
}
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pnperf-")); process.env.CHART_REVIEW_REVIEWS_ROOT = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_REVIEWS_ROOT; });

describe("computePerNotePerformance", () => {
  it("scores agent-vs-reviewer over validated notes only", async () => {
    const { computePerNotePerformance } = await import("./pernote-performance.js");
    writeState("session_001", "p1", "chart-review-acts", {
      review_status: "in_progress",
      validated_notes: ["n1"], // n2 not validated → excluded
      encounters: [{ encounter_id: "n1" }, { encounter_id: "n2" }],
      field_assessments: [
        // reviewer changed agent's n1/apoe4 from "0" to "1"
        { field_id: "apoe4", encounter_id: "n1", answer: "1", source: "reviewer", status: "approved",
          original_agent_snapshot: { answer: "0" } },
        // untouched agent draft on n1/imp
        { field_id: "imp", encounter_id: "n1", answer: "1", source: "agent", status: "agent_proposed" },
        // n2 not validated → ignored
        { field_id: "apoe4", encounter_id: "n2", answer: "1", source: "agent", status: "agent_proposed" },
      ],
    });
    const r = computePerNotePerformance("session_001", "chart-review-acts", ["apoe4", "imp"]);
    const apoe = r.agent_vs_reviewer.per_field.find((f) => f.field_id === "apoe4")!;
    expect(apoe.n).toBe(1);          // only n1
    expect(apoe.accuracy).toBe(0);   // agent "0" vs reviewer "1"
    const imp = r.agent_vs_reviewer.per_field.find((f) => f.field_id === "imp")!;
    expect(imp.accuracy).toBe(1);    // untouched → agree
    expect(r.validated_notes).toBe(1);
  });

  it("excludes a cleared cell (reviewer answer \"\") from scoring", async () => {
    const { computePerNotePerformance } = await import("./pernote-performance.js");
    writeState("session_002", "p1", "chart-review-acts", {
      validated_notes: ["n1"],
      encounters: [{ encounter_id: "n1" }],
      field_assessments: [
        // reviewer cleared the cell to "" — not a label, must not be scored
        { field_id: "apoe4", encounter_id: "n1", answer: "", source: "reviewer", status: "approved",
          original_agent_snapshot: { answer: "0" } },
      ],
    });
    const r = computePerNotePerformance("session_002", "chart-review-acts", ["apoe4"]);
    const apoe = r.agent_vs_reviewer.per_field.find((f) => f.field_id === "apoe4")!;
    expect(apoe.n).toBe(0);          // cleared cell excluded, no pair formed
    expect(apoe.accuracy).toBeNull();
  });
});
