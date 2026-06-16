import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession } from "./sessions.js";
import { getActiveVersion } from "@chart-review/rubric-versions";
import { sessionRubricRoot } from "@chart-review/rubric";

let root: string;
let prevRoot: string | undefined;
let prevOverride: string | undefined;

beforeEach(() => {
  prevRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
  prevOverride = process.env.CHART_REVIEW_RUBRIC_ROOT;
  delete process.env.CHART_REVIEW_RUBRIC_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = root;
  const base = path.join(root, ".claude", "skills", "chart-review-x", "references", "criteria");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "f.md"), "---\nfield_id: f\n---\nbaseline-rule");
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT; else process.env.CHART_REVIEW_PLATFORM_ROOT = prevRoot;
  if (prevOverride === undefined) delete process.env.CHART_REVIEW_RUBRIC_ROOT; else process.env.CHART_REVIEW_RUBRIC_ROOT = prevOverride;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createSession forks the baseline rubric", () => {
  it("copies the baseline into the session fork as s1 and stamps the manifest", () => {
    const m = createSession({
      task_id: "x",
      name: "s",
      started_by: "yuhang",
      patient_ids: ["p1"],
      agent_specs: [{ id: "agent_1", role_preset: "default", role_version: "v1" }],
    });
    const fork = sessionRubricRoot("x", m.session_id);
    expect(fs.readFileSync(path.join(fork, "references", "criteria", "f.md"), "utf8")).toContain("baseline-rule");
    expect(getActiveVersion(fork)).toBe("s1");
    const rubric = (m as { rubric?: { active_version: string; based_on: string } }).rubric;
    expect(rubric?.active_version).toBe("s1");
    expect(rubric?.based_on).toBe("v1");
  });

  it("two sessions get independent forks", () => {
    const a = createSession({ task_id: "x", name: "a", started_by: "y", patient_ids: ["p1"], agent_specs: [{ id: "agent_1", role_preset: "default", role_version: "v1" }] });
    const b = createSession({ task_id: "x", name: "b", started_by: "y", patient_ids: ["p1"], agent_specs: [{ id: "agent_1", role_preset: "default", role_version: "v1" }] });
    // edit A's fork; B's fork is untouched
    const forkA = sessionRubricRoot("x", a.session_id);
    fs.writeFileSync(path.join(forkA, "references", "criteria", "f.md"), "edited-A");
    const forkB = sessionRubricRoot("x", b.session_id);
    expect(fs.readFileSync(path.join(forkB, "references", "criteria", "f.md"), "utf8")).toContain("baseline-rule");
    expect(a.session_id).not.toBe(b.session_id);
  });
});
