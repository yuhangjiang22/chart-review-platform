/**
 * rerun-plan-preview.test.ts
 *
 * Tests for the GET /api/pilots/:taskId/rerun-plan-preview endpoint logic.
 *
 * Uses a synthetic task ID ("test-rerun-preview") so the skill-format loader
 * finds nothing and falls back to the legacy YAML path, which IS overrideable
 * via CHART_REVIEW_GUIDELINES_ROOT. Tests verify:
 *
 *  - Response has the expected fields.
 *  - carried_criteria + rerun_criteria sum to all leaf criteria (derived
 *    criteria are excluded).
 *  - prior_iter_id resolves to the most recent pilot iteration (or null).
 *  - Cost estimate is non-negative.
 *  - When all criteria are unchanged, cost is $0 and carried = all leaf.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import request from "supertest";

import { loadCriteria } from "../domain/rubric/index.js";
import { yamlCriterionToSkillMarkdown } from "../domain/rubric/yaml-to-markdown.js";
import { criterionSchemaHash, computeRerunPlan } from "../criterion-hash.js";
import { listPilotIterations } from "../domain/iter/index.js";
import { readCohortSampling } from "../domain/cohort/index.js";

// ── Mini express app factory ─────────────────────────────────────────────────
// Mirrors the server route exactly, but is self-contained for testing.

function buildTestApp(_platformRoot?: string) {
  const app = express();
  app.use(express.json());

  app.get("/api/pilots/:taskId/rerun-plan-preview", (req, res) => {
    const { taskId } = req.params as { taskId: string };

    const criteria = loadCriteria(taskId);
    const currentHashes: Record<string, string> = {};
    for (const c of criteria) {
      if ((c as any).derivation != null) continue;
      currentHashes[c.field_id] =
        c.schema_hash ?? criterionSchemaHash(c as Record<string, unknown>);
    }

    const allIters = listPilotIterations(taskId);
    const priorIter = allIters.length > 0 ? allIters[0] : null;
    const priorManifest = priorIter
      ? {
          iter_id: priorIter.iter_id,
          criterion_schema_hashes: priorIter.criterion_schema_hashes,
        }
      : null;

    const plan = computeRerunPlan(currentHashes, priorManifest);
    const priorHadCriterionHashes =
      priorManifest != null && priorManifest.criterion_schema_hashes != null;

    const COST_PER_CELL_USD = 0.034;
    const nRerun = plan.rerun_criteria.length;

    let nPatients = 5;
    try {
      const cohort = readCohortSampling(taskId);
      if (cohort?.dev_patient_ids?.length) nPatients = cohort.dev_patient_ids.length;
    } catch { /* ignore */ }

    const estimatedCostPerAgent =
      nRerun > 0 ? +(nRerun * nPatients * COST_PER_CELL_USD).toFixed(2) : 0;
    const costBasis =
      nRerun === 0
        ? "no agent runs needed (all criteria carry over)"
        : `${nPatients} patients x ${nRerun} criteria x $${COST_PER_CELL_USD}/cell (haiku-4.5 baseline)`;

    res.json({
      task_id: taskId,
      prior_iter_id: priorIter?.iter_id ?? null,
      prior_had_criterion_hashes: priorHadCriterionHashes,
      carried_criteria: plan.carried_criteria,
      rerun_criteria: plan.rerun_criteria,
      estimated_cost_usd_per_agent: estimatedCostPerAgent,
      estimated_cost_basis: costBasis,
      n_patients: nPatients,
    });
  });

  return app;
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

// Task ID chosen to have NO skill-format directory, so loadCriteria falls
// back to legacy YAML (which IS overrideable via CHART_REVIEW_GUIDELINES_ROOT).
const TASK_ID = "test-rerun-preview";

// Two leaf criteria and one derived criterion.
const LEAF_A = { id: "criterion_a", answer_schema: { enum: [true, false] }, cardinality: "one" };
const LEAF_B = { id: "criterion_b", answer_schema: { enum: ["yes", "no", "no_info"] }, cardinality: "one" };
const DERIVED = { id: "derived_c", derivation: "criterion_a && criterion_b ? 'yes' : 'no'" };

function yamlLine(k: string, v: unknown): string {
  return `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`;
}

function writeYaml(dir: string, name: string, doc: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, name),
    Object.entries(doc).map(([k, v]) => yamlLine(k, v)).join("\n") + "\n",
  );
}

/** Seed both YAML (criteria/<id>.yaml — for criterion-hash + archive) and
 *  skill-format markdown (.claude/skills/.../<id>.md — for loadCriteria). */
function seedCriterion(tmp: string, taskId: string, doc: Record<string, unknown>): void {
  const fieldId = (doc.field_id ?? doc.id) as string;
  const yamlDir = path.join(tmp, "guidelines", taskId, "criteria");
  fs.mkdirSync(yamlDir, { recursive: true });
  writeYaml(yamlDir, `${fieldId}.yaml`, doc);
  const skillDir = path.join(
    tmp, ".claude", "skills", `chart-review-${taskId}`, "references", "criteria",
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, `${fieldId}.md`),
    yamlCriterionToSkillMarkdown(doc),
  );
}

function makeDummyRun(tmp: string, runId: string): void {
  const runDir = path.join(tmp, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "status.json"),
    JSON.stringify({ state: "complete", n_complete: 2, n_patients: 2 }),
  );
}

function writePilotManifest(
  tmp: string,
  taskId: string,
  iterId: string,
  extras: Record<string, unknown> = {},
): void {
  // After T9, guidelineDir(taskId) = guidelinesRoot()/chart-review-<taskId>.
  // CHART_REVIEW_GUIDELINES_ROOT is set to TMP/guidelines in beforeEach, so
  // guidelineDir(taskId) = TMP/guidelines/chart-review-<taskId>.
  const pilotsDir = path.join(tmp, "guidelines", `chart-review-${taskId}`, "pilots", iterId);
  fs.mkdirSync(pilotsDir, { recursive: true });
  fs.writeFileSync(
    path.join(pilotsDir, "manifest.json"),
    JSON.stringify({
      task_id: taskId,
      iter_id: iterId,
      iter_num: parseInt(iterId.replace("iter_", ""), 10),
      run_id: `run_${iterId}`,
      guideline_sha: "abc123",
      started_at: "2026-05-01T00:00:00.000Z",
      started_by: "tester",
      state: "complete",
      ...extras,
    }),
  );
}

// ── Suite 1: no prior iter ────────────────────────────────────────────────────

describe("rerun-plan-preview — no prior iter (first iteration)", () => {
  let TMP: string;

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-preview-fresh-"));
    process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
    process.env.CHART_REVIEW_GUIDELINES_ROOT = path.join(TMP, "guidelines");
    process.env.CHART_REVIEW_RUNS_ROOT = path.join(TMP, "runs");

    seedCriterion(TMP, TASK_ID, LEAF_A);
    seedCriterion(TMP, TASK_ID, LEAF_B);
    seedCriterion(TMP, TASK_ID, DERIVED);
    // No pilots dir → no prior iter.
  });

  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    delete process.env.CHART_REVIEW_GUIDELINES_ROOT;
    delete process.env.CHART_REVIEW_RUNS_ROOT;
  });

  it("returns 200 with the expected top-level fields", async () => {
    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      task_id: TASK_ID,
      prior_iter_id: null,
      prior_had_criterion_hashes: false,
    });
    expect(Array.isArray(r.body.carried_criteria)).toBe(true);
    expect(Array.isArray(r.body.rerun_criteria)).toBe(true);
    expect(typeof r.body.estimated_cost_usd_per_agent).toBe("number");
    expect(typeof r.body.estimated_cost_basis).toBe("string");
    expect(typeof r.body.n_patients).toBe("number");
  });

  it("prior_iter_id is null when no iters exist", async () => {
    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    expect(r.body.prior_iter_id).toBeNull();
  });

  it("all leaf criteria are in rerun_criteria; derived criterion excluded", async () => {
    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    expect(r.status).toBe(200);
    const { carried_criteria, rerun_criteria } = r.body;
    expect(carried_criteria).toEqual([]);
    expect(rerun_criteria.sort()).toEqual(["criterion_a", "criterion_b"]);
    expect(rerun_criteria).not.toContain("derived_c");
  });

  it("carried + rerun sum to the count of leaf criteria", async () => {
    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    const total = r.body.carried_criteria.length + r.body.rerun_criteria.length;
    // 2 leaf criteria (criterion_a, criterion_b); derived_c is excluded.
    expect(total).toBe(2);
  });

  it("cost estimate is positive when all criteria need rerun", async () => {
    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    expect(r.body.estimated_cost_usd_per_agent).toBeGreaterThan(0);
  });
});

// ── Suite 2: with prior iter that has criterion hashes ────────────────────────

describe("rerun-plan-preview — with prior iter carrying criterion hashes", () => {
  let TMP: string;
  let hashA: string;
  let hashB: string;

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rerun-preview-prior-"));
    process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
    process.env.CHART_REVIEW_GUIDELINES_ROOT = path.join(TMP, "guidelines");
    process.env.CHART_REVIEW_RUNS_ROOT = path.join(TMP, "runs");

    seedCriterion(TMP, TASK_ID, LEAF_A);
    seedCriterion(TMP, TASK_ID, LEAF_B);
    seedCriterion(TMP, TASK_ID, DERIVED);

    // Compute actual hashes for both leaf criteria.
    hashA = criterionSchemaHash(LEAF_A as Record<string, unknown>);
    hashB = criterionSchemaHash(LEAF_B as Record<string, unknown>);

    // Create a dummy run so listPilotIterations's getRunStatus call doesn't error.
    makeDummyRun(TMP, "run_iter_001");

    // Write a prior iter with: criterion_a hash correct, criterion_b hash DIFFERENT.
    writePilotManifest(TMP, TASK_ID, "iter_001", {
      run_id: "run_iter_001",
      criterion_schema_hashes: {
        criterion_a: hashA,           // unchanged
        criterion_b: "old_hash_xyz",  // changed → triggers rerun
      },
    });
  });

  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    delete process.env.CHART_REVIEW_GUIDELINES_ROOT;
    delete process.env.CHART_REVIEW_RUNS_ROOT;
  });

  it("prior_iter_id equals the most recent iter", async () => {
    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    expect(r.status).toBe(200);
    expect(r.body.prior_iter_id).toBe("iter_001");
  });

  it("prior_had_criterion_hashes is true when prior manifest has hashes", async () => {
    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    expect(r.body.prior_had_criterion_hashes).toBe(true);
  });

  it("unchanged criterion is carried; changed criterion needs rerun", async () => {
    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    const { carried_criteria, rerun_criteria } = r.body;
    expect(carried_criteria).toContain("criterion_a");   // hash matches
    expect(rerun_criteria).toContain("criterion_b");     // hash changed
    expect(rerun_criteria).not.toContain("derived_c");   // derived: not tracked
  });

  it("carried + rerun sum to all leaf criteria", async () => {
    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    const total = r.body.carried_criteria.length + r.body.rerun_criteria.length;
    expect(total).toBe(2); // criterion_a + criterion_b
  });

  it("cost estimate is $0 when all criteria hashes match the prior iter", async () => {
    // Update the prior manifest so both hashes match.
    writePilotManifest(TMP, TASK_ID, "iter_001", {
      run_id: "run_iter_001",
      criterion_schema_hashes: {
        criterion_a: hashA,
        criterion_b: hashB, // now matches current
      },
    });

    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    expect(r.status).toBe(200);
    expect(r.body.estimated_cost_usd_per_agent).toBe(0);
    expect(r.body.carried_criteria).toHaveLength(2);
    expect(r.body.rerun_criteria).toHaveLength(0);
  });

  it("prior_had_criterion_hashes is false when prior manifest lacks hashes (legacy iter)", async () => {
    // Overwrite with a legacy-style manifest that has no criterion_schema_hashes.
    writePilotManifest(TMP, TASK_ID, "iter_001", {
      run_id: "run_iter_001",
      // no criterion_schema_hashes → whole-guideline rerun mode
    });

    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    expect(r.body.prior_had_criterion_hashes).toBe(false);
    // All criteria fall into rerun (whole-guideline mode).
    expect(r.body.carried_criteria).toHaveLength(0);
    expect(r.body.rerun_criteria.sort()).toEqual(["criterion_a", "criterion_b"]);
  });

  it("most recent iter is returned when multiple iters exist", async () => {
    // Add a second (newer) iter.
    makeDummyRun(TMP, "run_iter_002");
    writePilotManifest(TMP, TASK_ID, "iter_002", {
      run_id: "run_iter_002",
      iter_num: 2,
      criterion_schema_hashes: {
        criterion_a: hashA,
        criterion_b: hashB, // both match current
      },
    });

    const app = buildTestApp(TMP);
    const r = await request(app).get(`/api/pilots/${TASK_ID}/rerun-plan-preview`);
    // The most recent iter is iter_002 (highest iter_num).
    expect(r.body.prior_iter_id).toBe("iter_002");
    // Both hashes match iter_002 → 0 rerun, 2 carried.
    expect(r.body.rerun_criteria).toHaveLength(0);
    expect(r.body.carried_criteria).toHaveLength(2);
  });
});
