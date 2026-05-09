// app/server/__tests__/bundle-export-deployment.test.ts
//
// Tests for the deployment-validation section of the reproducibility bundle:
//  - Cohort manifests, stratified sample selections, reviewer validations,
//    and deployment-κ reports are bundled when their task_id matches.
//  - Cohorts for a different task_id are skipped.
//  - The deployment-issues log is included only for the requested
//    guideline_sha; other shas' logs stay out.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { _collectDeploymentCohorts, _collectDeploymentIssues } from "../domain/bundle/index.js";

let TMP: string;
let BUNDLE: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-deploy-"));
  BUNDLE = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-out-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
  process.env.CHART_REVIEW_COHORTS_ROOT = path.join(TMP, "cohorts");
});

afterEach(() => {
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  delete process.env.CHART_REVIEW_COHORTS_ROOT;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(BUNDLE, { recursive: true, force: true });
});

function seedCohort(
  cohortId: string,
  taskId: string,
  opts: {
    selections?: string[]; // run_ids whose selections are written
    validations?: Array<{ patient_id: string; task_id: string }>;
    reports?: string[]; // run_ids whose reports are written
  },
): void {
  const dir = path.join(TMP, "cohorts", cohortId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ cohort_id: cohortId, task_id: taskId, guideline_sha: "abc123", patient_ids: ["p1"] }),
  );
  for (const runId of opts.selections ?? []) {
    const sd = path.join(dir, "sample", "selections");
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, `${runId}.json`), JSON.stringify({ selected: ["p1"] }));
  }
  for (const v of opts.validations ?? []) {
    const vd = path.join(dir, "sample", "validations", v.patient_id, v.task_id);
    fs.mkdirSync(vd, { recursive: true });
    fs.writeFileSync(path.join(vd, "review_state.json"), JSON.stringify({ patient_id: v.patient_id }));
  }
  for (const runId of opts.reports ?? []) {
    const rd = path.join(dir, "reports", runId);
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, "deployment-kappa.json"), JSON.stringify({ overall_kappa: 0.7 }));
    fs.writeFileSync(path.join(rd, "deployment-kappa.md"), "## Deployment kappa\n");
  }
}

describe("_collectDeploymentCohorts", () => {
  it("bundles manifests, selections, validations, and reports for the matching task", () => {
    seedCohort("cohort-A", "lung", {
      selections: ["run_001", "run_002"],
      validations: [
        { patient_id: "p1", task_id: "lung" },
        { patient_id: "p2", task_id: "lung" },
      ],
      reports: ["run_001"],
    });

    const result = _collectDeploymentCohorts("lung", BUNDLE);
    expect(result.cohort_count).toBe(1);
    expect(result.sample_count).toBe(2);
    expect(result.validation_count).toBe(2);
    expect(result.report_count).toBe(1);

    expect(fs.existsSync(path.join(BUNDLE, "deployment_cohorts", "cohort-A", "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_cohorts", "cohort-A", "sample", "selections", "run_001.json"))).toBe(true);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_cohorts", "cohort-A", "sample", "validations", "p1", "lung", "review_state.json"))).toBe(true);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_cohorts", "cohort-A", "reports", "run_001", "deployment-kappa.json"))).toBe(true);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_cohorts", "cohort-A", "reports", "run_001", "deployment-kappa.md"))).toBe(true);
  });

  it("skips cohorts whose task_id doesn't match the export", () => {
    seedCohort("cohort-A", "lung", { selections: ["r1"] });
    seedCohort("cohort-B", "breast", { selections: ["r2"] });

    const result = _collectDeploymentCohorts("lung", BUNDLE);
    expect(result.cohort_count).toBe(1);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_cohorts", "cohort-A"))).toBe(true);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_cohorts", "cohort-B"))).toBe(false);
  });

  it("ignores validation files for other task_ids inside the same cohort dir", () => {
    seedCohort("multi", "lung", {
      validations: [
        { patient_id: "p1", task_id: "lung" },
        { patient_id: "p2", task_id: "breast" }, // different task in the same cohort tree
      ],
    });

    const result = _collectDeploymentCohorts("lung", BUNDLE);
    expect(result.validation_count).toBe(1);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_cohorts", "multi", "sample", "validations", "p1", "lung", "review_state.json"))).toBe(true);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_cohorts", "multi", "sample", "validations", "p2", "breast"))).toBe(false);
  });

  it("returns zero counts when the cohorts root doesn't exist", () => {
    const result = _collectDeploymentCohorts("lung", BUNDLE);
    expect(result).toEqual({ cohort_count: 0, sample_count: 0, validation_count: 0, report_count: 0 });
  });

  it("counts a cohort with manifest only (no samples/reports yet)", () => {
    seedCohort("cohort-A", "lung", {});
    const result = _collectDeploymentCohorts("lung", BUNDLE);
    expect(result.cohort_count).toBe(1);
    expect(result.sample_count).toBe(0);
    expect(result.validation_count).toBe(0);
    expect(result.report_count).toBe(0);
  });

  it("only counts a report when at least one of {json, md} is present", () => {
    // Set up a cohort with an empty reports/run_X dir — should NOT be counted
    seedCohort("cohort-A", "lung", {});
    const reportDir = path.join(TMP, "cohorts", "cohort-A", "reports", "run_zzz");
    fs.mkdirSync(reportDir, { recursive: true });
    // intentionally no files inside

    const result = _collectDeploymentCohorts("lung", BUNDLE);
    expect(result.report_count).toBe(0);
  });
});

describe("_collectDeploymentIssues", () => {
  it("copies the per-sha log when present", () => {
    const issuesDir = path.join(TMP, "deployment-issues");
    fs.mkdirSync(issuesDir, { recursive: true });
    fs.writeFileSync(
      path.join(issuesDir, "abc123.jsonl"),
      JSON.stringify({ kind: "issue", issue_id: "i1" }) + "\n" +
        JSON.stringify({ kind: "issue", issue_id: "i2" }) + "\n",
    );

    const count = _collectDeploymentIssues("abc123", BUNDLE);
    expect(count).toBe(2);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_issues", "abc123.jsonl"))).toBe(true);
  });

  it("returns 0 and writes no file when no log exists for that sha", () => {
    const count = _collectDeploymentIssues("abc123", BUNDLE);
    expect(count).toBe(0);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_issues"))).toBe(false);
  });

  it("does not bundle logs for other shas", () => {
    const issuesDir = path.join(TMP, "deployment-issues");
    fs.mkdirSync(issuesDir, { recursive: true });
    fs.writeFileSync(path.join(issuesDir, "abc123.jsonl"), JSON.stringify({ issue_id: "i1" }) + "\n");
    fs.writeFileSync(path.join(issuesDir, "deadbeef.jsonl"), JSON.stringify({ issue_id: "i2" }) + "\n");

    _collectDeploymentIssues("abc123", BUNDLE);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_issues", "abc123.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(BUNDLE, "deployment_issues", "deadbeef.jsonl"))).toBe(false);
  });

  it("counts non-empty lines, skipping blanks", () => {
    const issuesDir = path.join(TMP, "deployment-issues");
    fs.mkdirSync(issuesDir, { recursive: true });
    fs.writeFileSync(path.join(issuesDir, "abc123.jsonl"), `{"a":1}\n\n{"b":2}\n  \n{"c":3}\n`);
    expect(_collectDeploymentIssues("abc123", BUNDLE)).toBe(3);
  });
});
