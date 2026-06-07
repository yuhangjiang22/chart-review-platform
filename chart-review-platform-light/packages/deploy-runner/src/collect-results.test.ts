// packages/deploy-runner/src/collect-results.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectResults } from "./collect-results.js";

let root: string, out: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

// Write a fake promoted draft at the agentDraftPath location under `root`.
function draft(runId: string, pid: string, agentId: string, fas: unknown[]) {
  const d = path.join(root, "var", "runs", runId, "per_patient", pid, "agents");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${agentId}.json`), JSON.stringify({ field_assessments: fas }));
}

describe("collectResults", () => {
  it("writes per-patient json + csv + manifest; ok vs failed from status", () => {
    process.env.CHART_REVIEW_RUNS_ROOT = path.join(root, "var", "runs");
    const runId = "RUN1";
    draft(runId, "p_ok", "agent_1", [
      { field_id: "cancer_type", answer: "adenocarcinoma", confidence: "high", evidence: [] },
      { field_id: "disease_extent", answer: "no_info", confidence: "high", evidence: [] },
    ]);
    const status = {
      state: "complete_with_errors",
      per_patient: { p_ok: { state: "complete" }, p_fail: { state: "error", error: "boom" } },
      n_complete: 1, n_error: 1,
    } as any;
    const r = collectResults({
      runId, status, agentId: "agent_1", fieldIds: ["cancer_type", "disease_extent"],
      outDir: out, meta: { package_dir: "/pkg", task_id: "t1", agent_reason: "x",
        model: "gpt-4o", env_model: "gpt-4o", model_mismatch_warning: null, data_dir: "/dd" },
    });
    delete process.env.CHART_REVIEW_RUNS_ROOT;

    expect(r.n_ok).toBe(1);
    expect(r.n_failed).toBe(1);
    expect(r.failed_patient_ids).toEqual(["p_fail"]);
    // per-patient json for the ok patient
    const pj = JSON.parse(fs.readFileSync(path.join(out, "p_ok.json"), "utf8"));
    expect(pj.field_assessments).toHaveLength(2);
    // csv: header + one row (ok only)
    const csv = fs.readFileSync(path.join(out, "results.csv"), "utf8").trim().split("\n");
    expect(csv[0]).toBe("patient_id,cancer_type,disease_extent");
    expect(csv[1]).toBe("p_ok,adenocarcinoma,no_info");
    expect(csv).toHaveLength(2);
    // manifest
    const man = JSON.parse(fs.readFileSync(path.join(out, "run_manifest.json"), "utf8"));
    expect(man.n_ok).toBe(1);
    expect(man.failed_patient_ids).toEqual(["p_fail"]);
    expect(man.agent_id).toBe("agent_1");
  });
});
