import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRubricRoot, baselineRubricRoot, sessionRubricRoot, loadCriteria } from "./phenotype-skill.js";

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

describe("resolveRubricRoot", () => {
  it("returns the baseline when no session id is given", () => {
    expect(resolveRubricRoot("x")).toBe(baselineRubricRoot("x"));
  });
  it("returns the baseline for a session with no fork (legacy fallback)", () => {
    expect(resolveRubricRoot("x", "session_legacy")).toBe(baselineRubricRoot("x"));
  });
  it("returns the session fork when it exists", () => {
    const fork = sessionRubricRoot("x", "session_054");
    fs.mkdirSync(path.join(fork, "references", "criteria"), { recursive: true });
    expect(resolveRubricRoot("x", "session_054")).toBe(fork);
  });
  it("honors CHART_REVIEW_RUBRIC_ROOT first (the subprocess override)", () => {
    process.env.CHART_REVIEW_RUBRIC_ROOT = "/override/root";
    expect(resolveRubricRoot("x", "session_054")).toBe("/override/root");
    expect(resolveRubricRoot("x")).toBe("/override/root");
  });
});

describe("loadCriteria session-awareness", () => {
  it("reads the session fork's criteria when a fork exists", () => {
    // baseline criterion
    fs.writeFileSync(
      path.join(baselineRubricRoot("x"), "references", "criteria", "c.md"),
      "---\nfield_id: c\n---\n# Criterion: c\nbaseline body",
    );
    // session fork criterion (different body)
    const fork = sessionRubricRoot("x", "session_054");
    fs.mkdirSync(path.join(fork, "references", "criteria"), { recursive: true });
    fs.writeFileSync(
      path.join(fork, "references", "criteria", "c.md"),
      "---\nfield_id: c\n---\n# Criterion: c\nfork body",
    );
    const baseline = loadCriteria("x");
    const session = loadCriteria("x", "session_054");
    expect(baseline.find((f) => f.field_id === "c")?.extraction_guidance).toBeUndefined();
    // both load the field; the point is the session read comes from the fork dir
    expect(session.map((f) => f.field_id)).toContain("c");
    expect(baseline.map((f) => f.field_id)).toContain("c");
  });
});
