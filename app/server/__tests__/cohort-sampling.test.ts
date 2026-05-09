import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import request from "supertest";
import {
  readCohortSampling,
  writeCohortSampling,
  type CohortSampling,
  registerCohortSamplingRoutes,
} from "../domain/cohort/index.js";

describe("cohort-sampling", () => {
  let tmp: string;
  let prevPlatformRoot: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-"));
    prevPlatformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
    process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
    // Skill layout: .claude/skills/chart-review-test-task/
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "chart-review-test-task"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevPlatformRoot === undefined) {
      delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    } else {
      process.env.CHART_REVIEW_PLATFORM_ROOT = prevPlatformRoot;
    }
  });

  it("returns null when sampling.json is absent", () => {
    expect(readCohortSampling("test-task")).toBeNull();
  });

  it("round-trips a cohort definition", () => {
    const cohort: CohortSampling = {
      task_id: "test-task",
      version: 1,
      created_at: "2026-05-02T00:00:00.000Z",
      created_by: "test_pi",
      dev_patient_ids: ["p_dev_01", "p_dev_02"],
      lock_patient_ids: ["p_lock_01", "p_lock_02", "p_lock_03"],
      stratification_notes: "≥1 positive, ≥1 negative, ≥1 edge per primary criterion",
    };
    writeCohortSampling("test-task", cohort);
    expect(readCohortSampling("test-task")).toEqual(cohort);
  });

  it("rejects DEV/LOCK overlap", () => {
    const bad: CohortSampling = {
      task_id: "test-task",
      version: 1,
      created_at: "2026-05-02T00:00:00.000Z",
      created_by: "test_pi",
      dev_patient_ids: ["p_01", "p_02"],
      lock_patient_ids: ["p_02", "p_03"],
    };
    expect(() => writeCohortSampling("test-task", bad)).toThrow(/overlap/i);
  });
});

it("GET returns 404 when no cohort exists, 200 with body when it does", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-"));
  const prevRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
  try {
    process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "chart-review-test-task"), { recursive: true });
    const app = express();
    app.use(express.json());
    registerCohortSamplingRoutes(app);

    let r = await request(app).get("/api/cohort-sampling/test-task");
    expect(r.status).toBe(404);

    await request(app).put("/api/cohort-sampling/test-task").send({
      task_id: "test-task",
      version: 1,
      created_at: "2026-05-02T00:00:00.000Z",
      created_by: "test_pi",
      dev_patient_ids: ["p_dev_01"],
      lock_patient_ids: ["p_lock_01"],
    });

    r = await request(app).get("/api/cohort-sampling/test-task");
    expect(r.status).toBe(200);
    expect(r.body.dev_patient_ids).toEqual(["p_dev_01"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevRoot === undefined) {
      delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    } else {
      process.env.CHART_REVIEW_PLATFORM_ROOT = prevRoot;
    }
  }
});
