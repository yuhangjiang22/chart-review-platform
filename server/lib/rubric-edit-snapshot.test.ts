import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotAfterEdit } from "./rubric-edit-snapshot.js";
import { getActiveVersion } from "@chart-review/rubric-versions";
import { baselineRubricRoot } from "@chart-review/rubric";

let root: string;
let prevRoot: string | undefined;
let prevOverride: string | undefined;

beforeEach(() => {
  prevRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
  prevOverride = process.env.CHART_REVIEW_RUBRIC_ROOT;
  delete process.env.CHART_REVIEW_RUBRIC_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = root;
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT; else process.env.CHART_REVIEW_PLATFORM_ROOT = prevRoot;
  if (prevOverride === undefined) delete process.env.CHART_REVIEW_RUBRIC_ROOT; else process.env.CHART_REVIEW_RUBRIC_ROOT = prevOverride;
  fs.rmSync(root, { recursive: true, force: true });
});

function seedFork() {
  const fork = path.join(root, ".claude", "skills", "chart-review-x", "sessions", "s1", "rubric");
  fs.mkdirSync(path.join(fork, "references", "criteria"), { recursive: true });
  fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "edited");
  return fork;
}

describe("snapshotAfterEdit", () => {
  it("snapshots a SESSION version (prefix s) when the session has a fork", () => {
    const fork = seedFork();
    snapshotAfterEdit({ taskId: "x", sessionId: "s1", source: "refine:cancer_type", by: "yuhang" });
    expect(getActiveVersion(fork)).toBe("s1");
  });

  it("snapshots a BASELINE version (prefix v) for a no-session edit", () => {
    const base = path.join(baselineRubricRoot("x"), "references", "criteria");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "f.md"), "baseline-edited");
    snapshotAfterEdit({ taskId: "x", source: "author-edit", by: "yuhang" });
    expect(getActiveVersion(baselineRubricRoot("x"))).toBe("v1");
  });
});
