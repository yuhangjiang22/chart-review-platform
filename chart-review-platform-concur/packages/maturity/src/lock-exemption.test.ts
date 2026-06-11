import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { transitionMaturity } from "./index.js";

// Regression guard for FIX 4: the calibrated→locked transition runs a
// phenotype-shaped lock-test guard (no passed lock test for the current SHA →
// throw). NER tasks were exempted (kind !== "ner"); adherence was NOT, so an
// adherence task could never reach "locked" even after calibration. The
// exemption now covers both NER and adherence; phenotype stays gated.

let tmpRoot: string;
let prevGuidelinesRoot: string | undefined;

function writeGuideline(taskId: string, taskKind: string): void {
  const dir = path.join(tmpRoot, `chart-review-${taskId}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.yaml"), `task_type: ${taskKind}\ntask_kind: ${taskKind}\n`);
  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${taskId}\n`);
  // Seed the record at "calibrated" so the next hop is calibrated→locked.
  fs.writeFileSync(
    path.join(dir, "maturity.json"),
    JSON.stringify({ task_id: taskId, state: "calibrated", transitions: [] }, null, 2),
  );
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maturity-exempt-"));
  prevGuidelinesRoot = process.env.CHART_REVIEW_GUIDELINES_ROOT;
  process.env.CHART_REVIEW_GUIDELINES_ROOT = tmpRoot;
});

afterEach(() => {
  if (prevGuidelinesRoot === undefined) delete process.env.CHART_REVIEW_GUIDELINES_ROOT;
  else process.env.CHART_REVIEW_GUIDELINES_ROOT = prevGuidelinesRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("calibrated→locked lock-test exemption", () => {
  it("phenotype is still gated — no passed lock test → throws", () => {
    writeGuideline("pheno-x", "phenotype");
    expect(() => transitionMaturity("pheno-x", "locked", "tester")).toThrow(/lock test/i);
  });

  it("ner is exempt — locks without a lock test", () => {
    writeGuideline("ner-x", "ner");
    const rec = transitionMaturity("ner-x", "locked", "tester");
    expect(rec.state).toBe("locked");
  });

  it("adherence is exempt — locks without a lock test (the FIX 4 bug)", () => {
    writeGuideline("adh-x", "adherence");
    const rec = transitionMaturity("adh-x", "locked", "tester");
    expect(rec.state).toBe("locked");
  });
});
