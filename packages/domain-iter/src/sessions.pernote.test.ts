import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// createSession reads PLATFORM_ROOT via @chart-review/patients → guidelineDir.
// Point it at a temp skills tree with a minimal baseline rubric so forkFrom works.
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sess-pernote-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  const ref = path.join(tmp, ".claude", "skills", "chart-review-acts", "references", "criteria");
  fs.mkdirSync(ref, { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "skills", "chart-review-acts", "meta.yaml"), "task_type: phenotype_validation\n");
  fs.writeFileSync(path.join(ref, "impaired_cognition.md"), "---\nfield_id: impaired_cognition\nanswer_schema:\n  enum: [\"1\",\"0\"]\n---\nx\n");
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_PLATFORM_ROOT; });

describe("createSession per_note", () => {
  it("persists per_note:true when requested", async () => {
    const { createSession } = await import("./sessions.js");
    // task_id "acts" → guidelineDir resolves to <tmp>/.claude/skills/chart-review-acts
    const m = createSession({ task_id: "acts", name: "pn", started_by: "t", patient_ids: ["p1"], per_note: true });
    expect(m.per_note).toBe(true);
  });
  it("omits per_note when not requested", async () => {
    const { createSession } = await import("./sessions.js");
    const m = createSession({ task_id: "acts", name: "no-pn", started_by: "t", patient_ids: ["p1"] });
    expect(m.per_note).toBeUndefined();
  });
});
