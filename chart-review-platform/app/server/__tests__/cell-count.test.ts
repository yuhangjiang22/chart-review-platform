/**
 * Tests for GET /api/guideline-improvement/:taskId/cell-count (A3).
 *
 * The endpoint reads review_state.json directly from disk and counts
 * field_assessments where updated_by === "reviewer" AND review_status is
 * "reviewer_validated" or "locked" on the same patient record.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { guidelineRouter } from "../adapters/http/guideline-routes.js";

// ── helpers ───────────────────────────────────────────────────────────────────

let TMP: string;
const TASK_ID = "task-cc";

function buildApp() {
  const app = express();
  app.use(guidelineRouter());
  return app;
}

function writeReviewState(
  patientId: string,
  overrides: {
    review_status?: string;
    field_assessments?: Array<{ field_id: string; updated_by?: string }>;
  },
) {
  const dir = path.join(TMP, patientId, TASK_ID);
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    schema_version: "1",
    patient_id: patientId,
    task_id: TASK_ID,
    version: 1,
    updated_at: new Date().toISOString(),
    updated_by: "reviewer",
    review_status: "reviewer_validated",
    field_assessments: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify(state));
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cell-count-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/guideline-improvement/:taskId/cell-count", () => {
  it("returns {validated: 0, total: 0} when reviews root is empty", async () => {
    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/cell-count`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ validated: 0, total: 0 });
  });

  it("counts 20 validated cells across 5 patients × 4 criteria when all complete", async () => {
    // 5 patients, each with 4 criteria, all reviewer_validated and updated_by=reviewer
    for (let i = 1; i <= 5; i++) {
      writeReviewState(`patient-${i}`, {
        review_status: "reviewer_validated",
        field_assessments: [
          { field_id: "C1", updated_by: "reviewer" },
          { field_id: "C2", updated_by: "reviewer" },
          { field_id: "C3", updated_by: "reviewer" },
          { field_id: "C4", updated_by: "reviewer" },
        ],
      });
    }

    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/cell-count`,
    );
    expect(res.status).toBe(200);
    expect(res.body.validated).toBe(20);
    expect(res.body.total).toBe(20);
  });

  it("counts locked records as validated too", async () => {
    writeReviewState("patient-locked", {
      review_status: "locked",
      field_assessments: [
        { field_id: "C1", updated_by: "reviewer" },
        { field_id: "C2", updated_by: "reviewer" },
      ],
    });

    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/cell-count`,
    );
    expect(res.status).toBe(200);
    expect(res.body.validated).toBe(2);
  });

  it("returns partial count when 3 of 5 patients have updated_by: agent (not reviewer)", async () => {
    // 2 patients with reviewer-validated cells
    for (let i = 1; i <= 2; i++) {
      writeReviewState(`patient-r${i}`, {
        review_status: "reviewer_validated",
        field_assessments: [
          { field_id: "C1", updated_by: "reviewer" },
          { field_id: "C2", updated_by: "reviewer" },
          { field_id: "C3", updated_by: "reviewer" },
          { field_id: "C4", updated_by: "reviewer" },
        ],
      });
    }
    // 3 patients where assessments are by agent (not reviewer-validated either)
    for (let i = 1; i <= 3; i++) {
      writeReviewState(`patient-a${i}`, {
        review_status: "agent_complete",
        field_assessments: [
          { field_id: "C1", updated_by: "agent" },
          { field_id: "C2", updated_by: "agent" },
          { field_id: "C3", updated_by: "agent" },
          { field_id: "C4", updated_by: "agent" },
        ],
      });
    }

    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/cell-count`,
    );
    expect(res.status).toBe(200);
    // Only the 2 reviewer_validated patients count: 2 × 4 = 8 validated
    expect(res.body.validated).toBe(8);
    // total includes all patients: 5 × 4 = 20
    expect(res.body.total).toBe(20);
  });

  it("does not count cells with review_status reviewer_validated but updated_by agent", async () => {
    // reviewer_validated but agent wrote all fields — only partially reviewed
    writeReviewState("patient-mix", {
      review_status: "reviewer_validated",
      field_assessments: [
        { field_id: "C1", updated_by: "agent" },
        { field_id: "C2", updated_by: "reviewer" },
        { field_id: "C3", updated_by: "agent" },
      ],
    });

    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/cell-count`,
    );
    expect(res.status).toBe(200);
    expect(res.body.validated).toBe(1); // only C2 has updated_by=reviewer
    expect(res.body.total).toBe(3);
  });

  it("skips patients without a review_state.json for this task", async () => {
    // Create a patient dir but no review_state for this task
    fs.mkdirSync(path.join(TMP, "patient-other", "other-task"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(TMP, "patient-other", "other-task", "review_state.json"),
      JSON.stringify({
        schema_version: "1",
        patient_id: "patient-other",
        task_id: "other-task",
        version: 1,
        updated_at: new Date().toISOString(),
        updated_by: "reviewer",
        review_status: "reviewer_validated",
        field_assessments: [{ field_id: "C1", updated_by: "reviewer" }],
      }),
    );

    const res = await request(buildApp()).get(
      `/api/guideline-improvement/${TASK_ID}/cell-count`,
    );
    expect(res.status).toBe(200);
    expect(res.body.validated).toBe(0);
    expect(res.body.total).toBe(0);
  });
});
