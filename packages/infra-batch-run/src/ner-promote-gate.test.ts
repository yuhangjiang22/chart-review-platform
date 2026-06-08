import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  decidePromote,
  emptyNerDraft,
  agentDraftPath,
  perPatientDir,
  atomicWriteJson,
} from "./runs.js";

// B1 contract: a NER agent classified `ok` with ZERO spans produced NO scratch
// review_state.json (mcp-core-ner only writes it once a span is persisted). The
// promote gate must SYNTHESIZE an empty NER draft at agents/<id>.json and write
// NO `.error.json` marker — the pre-fix code force-failed this case (wrote a
// marker + returned error), inverting the empty-NER-is-valid spec rule.
//
// The promote decision lives inside runOneAgent, which needs heavy SDK/MCP
// mocking to drive end-to-end. We extracted the decision into the pure
// `decidePromote` helper (used by runOneAgent) and pin the contract here both
// at the pure-decision level and at the fs seam, executing the decision exactly
// as runOneAgent does.

describe("decidePromote (pure promote-gate decision)", () => {
  it("renames the scratch when it exists (any kind)", () => {
    expect(decidePromote({ taskKind: "ner", scratchExists: true })).toEqual({ kind: "rename" });
    expect(decidePromote({ taskKind: "phenotype", scratchExists: true })).toEqual({ kind: "rename" });
  });

  it("synthesizes an empty NER draft when scratch is absent for NER", () => {
    expect(decidePromote({ taskKind: "ner", scratchExists: false }))
      .toEqual({ kind: "synthesize-empty-ner" });
  });

  it("errors when scratch is absent for phenotype/adherence", () => {
    expect(decidePromote({ taskKind: "phenotype", scratchExists: false })).toEqual({ kind: "error" });
    expect(decidePromote({ taskKind: "adherence", scratchExists: false })).toEqual({ kind: "error" });
  });
});

describe("NER zero-span promote gate (fs seam)", () => {
  let tmp: string;
  const prev = process.env.CHART_REVIEW_RUNS_ROOT;
  const runId = "test-run";
  const pid = "patient_001";
  const taskId = "bso-ad-ner";
  const agentId = "agent_1";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ner-promote-"));
    process.env.CHART_REVIEW_RUNS_ROOT = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CHART_REVIEW_RUNS_ROOT;
    else process.env.CHART_REVIEW_RUNS_ROOT = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Mirror the promote block in runOneAgent for an OK outcome, NER task, no
  // scratch file (zero spans found).
  function runPromoteForOkNerZeroSpans(): void {
    const scratchExists = false; // zero spans → mcp-core-ner never wrote scratch
    const decision = decidePromote({ taskKind: "ner", scratchExists });
    if (decision.kind === "synthesize-empty-ner") {
      atomicWriteJson(agentDraftPath(runId, pid, agentId), emptyNerDraft(pid, taskId));
    }
    // (No `error` / `rename` branch is reachable here: NER + scratchExists=false
    //  always yields `synthesize-empty-ner`.)
  }

  it("promotes an empty NER draft and writes NO error marker", () => {
    runPromoteForOkNerZeroSpans();

    const draftPath = agentDraftPath(runId, pid, agentId);
    const markerPath = path.join(perPatientDir(runId, pid), "agents", `${agentId}.error.json`);

    // PRE-FIX: this assertion fails — the old gate wrote the marker, not a draft.
    expect(fs.existsSync(draftPath)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);

    const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    expect(draft.task_kind).toBe("ner");
    expect(draft.span_labels).toEqual([]);
    expect(draft.patient_id).toBe(pid);
    expect(draft.task_id).toBe(taskId);
    expect(draft.review_status).toBe("draft");
  });
});
