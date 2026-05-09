// app/server/__tests__/cohorts.test.ts
//
// Unit tests for the cohort manifest + run management module.
// Avoids startCohortRun (requires real task + Claude SDK); tests the
// pure manifest/read/list logic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  defineCohort,
  listCohorts,
  getCohortManifest,
  listCohortRuns,
  cohortsRoot,
  cohortDir,
  cohortManifestPath,
  cohortRunDir,
} from "../domain/cohort/index.js";
import { atomicWriteJson, manifestPath, statusPath, runDir } from "../infra/batch-run/index.js";

let TMP: string;
let patientsRoot: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cohorts-test-"));
  patientsRoot = path.join(TMP, "corpus", "patients");

  // Set env vars so all modules point at the temp tree
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
  process.env.CHART_REVIEW_CORPUS_ROOT = path.join(TMP, "corpus");
  process.env.CHART_REVIEW_RUNS_ROOT = path.join(TMP, "runs");
  process.env.CHART_REVIEW_COHORTS_ROOT = path.join(TMP, "cohorts");
  process.env.CHART_REVIEW_GUIDELINES_ROOT = path.join(TMP, "guidelines");
});

afterEach(() => {
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  delete process.env.CHART_REVIEW_CORPUS_ROOT;
  delete process.env.CHART_REVIEW_RUNS_ROOT;
  delete process.env.CHART_REVIEW_COHORTS_ROOT;
  delete process.env.CHART_REVIEW_GUIDELINES_ROOT;
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal patient directory so validatePatientIds passes. */
function seedPatient(patientId: string): void {
  fs.mkdirSync(path.join(patientsRoot, patientId), { recursive: true });
}

/** Create a minimal skill-bundle directory so loadCompiledTask passes.
 *  isSkillBundleAt now requires both meta.yaml AND SKILL.md.
 *  guidelineDir(taskId) resolves to <guidelinesRoot()>/chart-review-<taskId>. */
function seedTask(taskId: string): void {
  // CHART_REVIEW_GUIDELINES_ROOT is set to path.join(TMP, "guidelines") in beforeEach,
  // so guidelinesRoot() returns that; guidelineDir(taskId) appends "chart-review-<taskId>".
  const guidelineDir = path.join(TMP, "guidelines", `chart-review-${taskId}`);
  fs.mkdirSync(guidelineDir, { recursive: true });
  // meta.yaml is the detection sentinel for isSkillBundleAt
  fs.writeFileSync(
    path.join(guidelineDir, "meta.yaml"),
    `task_id: ${taskId}\nmanual_version: "test-1.0"\nsource_document_sha: "abc123"\n`,
  );
  // SKILL.md is now also required by isSkillBundleAt
  fs.writeFileSync(
    path.join(guidelineDir, "SKILL.md"),
    `---\nname: chart-review-${taskId}\ndescription: Test phenotype skill.\n---\n`,
  );
  // No criteria dir needed for basic tests (loadSkillBundle tolerates absence)
}

/** Seed a run manifest with a cohort_id in the temp runs root. */
function seedRunWithCohort(runId: string, taskId: string, cohortId: string): void {
  const dir = path.join(TMP, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    run_id: runId,
    task_id: taskId,
    cohort_id: cohortId,
    guideline_sha: "abc123",
    started_at: "2026-05-03T00:00:00.000Z",
    started_by: "tester",
    patient_ids: ["p_01"],
    max_concurrency: 1,
    max_turns_per_patient: 30,
    model: "test",
    cost_cap_usd: 10,
    kind: "agent_batch_run",
  };
  const status = {
    run_id: runId,
    state: "complete",
    started_at: manifest.started_at,
    updated_at: manifest.started_at,
    completed_at: manifest.started_at,
    total_cost_usd: 0,
    n_patients: 1,
    n_complete: 1,
    n_error: 0,
    n_running: 0,
    per_patient: { p_01: { state: "complete" } },
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
}

// ── layout helper tests ───────────────────────────────────────────────────────

describe("layout helpers", () => {
  it("cohortDir returns path under cohortsRoot", () => {
    const root = cohortsRoot();
    expect(cohortDir("my-cohort")).toBe(path.join(root, "my-cohort"));
  });

  it("cohortManifestPath returns manifest.json inside cohortDir", () => {
    expect(cohortManifestPath("my-cohort")).toBe(
      path.join(cohortsRoot(), "my-cohort", "manifest.json"),
    );
  });

  it("cohortRunDir returns runs subpath inside cohortDir", () => {
    expect(cohortRunDir("my-cohort", "run-123")).toBe(
      path.join(cohortsRoot(), "my-cohort", "runs", "run-123"),
    );
  });
});

// ── defineCohort ──────────────────────────────────────────────────────────────

describe("defineCohort", () => {
  it("writes manifest.json with correct fields", () => {
    seedTask("test-task");
    seedPatient("p_01");
    seedPatient("p_02");

    const manifest = defineCohort({
      cohort_id: "test-cohort",
      task_id: "test-task",
      patient_ids: ["p_01", "p_02"],
      created_by: "methodologist",
      notes: "integration test",
    });

    expect(manifest.cohort_id).toBe("test-cohort");
    expect(manifest.task_id).toBe("test-task");
    expect(manifest.patient_ids).toEqual(["p_01", "p_02"]);
    expect(manifest.created_by).toBe("methodologist");
    expect(manifest.notes).toBe("integration test");
    expect(typeof manifest.guideline_sha).toBe("string");
    expect(manifest.guideline_sha.length).toBeGreaterThan(0);
    expect(typeof manifest.created_at).toBe("string");

    // File was written
    const p = cohortManifestPath("test-cohort");
    expect(fs.existsSync(p)).toBe(true);
    const fromDisk = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(fromDisk).toMatchObject(manifest);
  });

  it("rejects an unknown task_id", () => {
    seedPatient("p_01");
    expect(() =>
      defineCohort({
        cohort_id: "c1",
        task_id: "nonexistent-task",
        patient_ids: ["p_01"],
        created_by: "m",
      }),
    ).toThrow(/task_id.*not found/i);
  });

  it("rejects unknown patient_ids", () => {
    seedTask("test-task");
    seedPatient("p_01");
    expect(() =>
      defineCohort({
        cohort_id: "c1",
        task_id: "test-task",
        patient_ids: ["p_01", "p_ghost"],
        created_by: "m",
      }),
    ).toThrow(/unknown patient_ids.*p_ghost/i);
  });

  it("rejects duplicate cohort_id", () => {
    seedTask("test-task");
    seedPatient("p_01");

    defineCohort({
      cohort_id: "dup-cohort",
      task_id: "test-task",
      patient_ids: ["p_01"],
      created_by: "m",
    });

    expect(() =>
      defineCohort({
        cohort_id: "dup-cohort",
        task_id: "test-task",
        patient_ids: ["p_01"],
        created_by: "m",
      }),
    ).toThrow(/already exists/i);
  });

  it("rejects invalid cohort_id characters", () => {
    seedTask("test-task");
    seedPatient("p_01");
    expect(() =>
      defineCohort({
        cohort_id: "bad cohort!",
        task_id: "test-task",
        patient_ids: ["p_01"],
        created_by: "m",
      }),
    ).toThrow(/invalid cohort_id/i);
  });
});

// ── listCohorts / getCohortManifest ───────────────────────────────────────────

describe("listCohorts / getCohortManifest", () => {
  it("listCohorts returns empty array when cohorts dir absent", () => {
    expect(listCohorts()).toEqual([]);
  });

  it("getCohortManifest returns null for unknown cohort", () => {
    expect(getCohortManifest("nope")).toBeNull();
  });

  it("round-trips: listCohorts returns what defineCohort wrote", () => {
    seedTask("test-task");
    seedPatient("p_01");
    seedPatient("p_02");

    const m1 = defineCohort({
      cohort_id: "cohort-a",
      task_id: "test-task",
      patient_ids: ["p_01"],
      created_by: "alice",
    });
    const m2 = defineCohort({
      cohort_id: "cohort-b",
      task_id: "test-task",
      patient_ids: ["p_02"],
      created_by: "bob",
    });

    const all = listCohorts();
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.cohort_id === "cohort-a")).toMatchObject(m1);
    expect(all.find((c) => c.cohort_id === "cohort-b")).toMatchObject(m2);
  });

  it("getCohortManifest returns the written manifest", () => {
    seedTask("test-task");
    seedPatient("p_01");

    const written = defineCohort({
      cohort_id: "get-test",
      task_id: "test-task",
      patient_ids: ["p_01"],
      created_by: "tester",
    });

    const read = getCohortManifest("get-test");
    expect(read).toMatchObject(written);
  });
});

// ── listCohortRuns ────────────────────────────────────────────────────────────

describe("listCohortRuns", () => {
  it("returns empty array when no runs exist", () => {
    expect(listCohortRuns("no-cohort")).toEqual([]);
  });

  it("finds runs that have matching cohort_id", () => {
    seedRunWithCohort("run-2026-05-03T00-00-00-000Z", "test-task", "my-cohort");
    seedRunWithCohort("run-2026-05-03T01-00-00-000Z", "test-task", "other-cohort");

    const runs = listCohortRuns("my-cohort");
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe("run-2026-05-03T00-00-00-000Z");
  });

  it("does not include runs belonging to other cohorts", () => {
    seedRunWithCohort("run-aaa", "test-task", "cohort-a");
    seedRunWithCohort("run-bbb", "test-task", "cohort-b");

    expect(listCohortRuns("cohort-a")).toHaveLength(1);
    expect(listCohortRuns("cohort-b")).toHaveLength(1);
    expect(listCohortRuns("cohort-c")).toHaveLength(0);
  });

  it("does not include runs without cohort_id", () => {
    // Seed a plain (non-cohort) run
    const dir = path.join(TMP, "runs", "plain-run");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        run_id: "plain-run",
        task_id: "test-task",
        guideline_sha: "abc",
        started_at: "2026-05-03T00:00:00.000Z",
        started_by: "tester",
        patient_ids: [],
        max_concurrency: 1,
        max_turns_per_patient: 30,
        model: "test",
        cost_cap_usd: 10,
        kind: "agent_batch_run",
      }),
    );
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({
        run_id: "plain-run",
        state: "complete",
        started_at: "2026-05-03T00:00:00.000Z",
        updated_at: "2026-05-03T00:00:00.000Z",
        completed_at: "2026-05-03T00:00:00.000Z",
        total_cost_usd: 0,
        n_patients: 0,
        n_complete: 0,
        n_error: 0,
        n_running: 0,
        per_patient: {},
      }),
    );

    expect(listCohortRuns("test-task")).toHaveLength(0);
  });
});
