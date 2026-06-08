import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { hasAnyAgentDraft, readDraft, perPatientDir } from "./runs.js";

// The loud-fail wiring writes `agents/<id>.error.json` markers for agents that
// errored / made no qualifying writes, and does NOT promote a draft. The
// reader-side gate (hasAnyAgentDraft, readDraft, and the jobs-routes import
// enumeration) must treat a `.error.json` marker as NOT a draft — otherwise a
// failed agent would look like it produced output. This test pins that
// exclusion contract on the filesystem read helpers.

describe("error-marker exclusion in agent-draft readers", () => {
  let tmp: string;
  const prev = process.env.CHART_REVIEW_RUNS_ROOT;
  const runId = "test-run";
  const pid = "patient_001";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-marker-"));
    process.env.CHART_REVIEW_RUNS_ROOT = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CHART_REVIEW_RUNS_ROOT;
    else process.env.CHART_REVIEW_RUNS_ROOT = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeAgentsFile(name: string, body: unknown): void {
    const dir = path.join(perPatientDir(runId, pid), "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  }

  it("hasAnyAgentDraft is false when only an .error.json marker exists", () => {
    writeAgentsFile("agent_1.error.json", { agent_id: "agent_1", status: "error", error: "boom" });
    expect(hasAnyAgentDraft(runId, pid)).toBe(false);
  });

  it("hasAnyAgentDraft is true when a real draft exists alongside a marker", () => {
    writeAgentsFile("agent_1.error.json", { agent_id: "agent_1", status: "error", error: "boom" });
    writeAgentsFile("agent_2.json", { field_assessments: [] });
    expect(hasAnyAgentDraft(runId, pid)).toBe(true);
  });

  it("readDraft skips the .error.json marker and returns the real draft", () => {
    // agent_1 failed (marker), agent_2 produced a draft. The fallback that
    // picks the lowest-sorted agent file must skip the marker.
    writeAgentsFile("agent_1.error.json", { agent_id: "agent_1", status: "error", error: "boom" });
    writeAgentsFile("agent_2.json", { field_assessments: [{ field_id: "cancer_type" }] });
    expect(readDraft(runId, pid)).toEqual({ field_assessments: [{ field_id: "cancer_type" }] });
  });

  it("readDraft returns null when every agent failed (only markers present)", () => {
    writeAgentsFile("agent_1.error.json", { agent_id: "agent_1", status: "error", error: "boom" });
    writeAgentsFile("agent_2.error.json", { agent_id: "agent_2", status: "error", error: "boom" });
    expect(readDraft(runId, pid)).toBeNull();
  });
});
