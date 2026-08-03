import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rubricRootForRun } from "./runs.js";
import { baselineRubricRoot, sessionRubricRoot } from "@chart-review/rubric";

let root: string;
let prevRoot: string | undefined;
let prevOverride: string | undefined;

beforeEach(() => {
  prevRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
  prevOverride = process.env.CHART_REVIEW_RUBRIC_ROOT;
  delete process.env.CHART_REVIEW_RUBRIC_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = root;
  fs.mkdirSync(path.join(root, ".claude", "skills", "chart-review-x", "references", "criteria"), { recursive: true });
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT; else process.env.CHART_REVIEW_PLATFORM_ROOT = prevRoot;
  if (prevOverride === undefined) delete process.env.CHART_REVIEW_RUBRIC_ROOT; else process.env.CHART_REVIEW_RUBRIC_ROOT = prevOverride;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("rubricRootForRun", () => {
  it("falls back to the baseline when the session has no fork", () => {
    expect(rubricRootForRun("x", "session_legacy")).toBe(baselineRubricRoot("x"));
  });
  it("uses the session fork when it exists", () => {
    const fork = sessionRubricRoot("x", "session_054");
    fs.mkdirSync(path.join(fork, "references", "criteria"), { recursive: true });
    expect(rubricRootForRun("x", "session_054")).toBe(fork);
  });
});
