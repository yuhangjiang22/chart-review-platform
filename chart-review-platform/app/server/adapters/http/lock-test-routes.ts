/**
 * adapters/http/lock-test-routes — HTTP adapter for the lock-test (held-out
 * cohort verification) workflow that gates calibrated → locked maturity.
 *
 * Held-out cohort verification: the agent runs against the LOCK cohort, then
 * the oracle annotates each lock patient with the copilot in *blind mode*
 * (the agent's draft is hidden). When all are validated, /finalize computes
 * per-criterion accuracy and pass/fail per LOCK_THRESHOLD.
 *
 * Routes registered:
 *   POST   /api/lock-test/:taskId/start
 *   GET    /api/lock-test/:taskId
 *   POST   /api/lock-test/:taskId/:runId/finalize
 *   GET    /api/lock-test/:taskId/:runId/detail
 */

import { Router } from "express";
import fs from "fs";
import path from "path";
import {
  startLockTest,
  finalizeLockTest,
  listLockTests,
  readLockTestManifest,
  writeLockTestManifest,
  type LockTestManifest,
} from "../../lock-test.js";
import { readCohortSampling } from "../../domain/cohort/index.js";
import {
  readPrimaryCriterionIds,
  computeIterAccuracy,
} from "../../domain/iter/index.js";
import { startBatchRun } from "../../infra/batch-run/index.js";
import { guidelineDir } from "../../domain/rubric/index.js";
import { computeTaskSha } from "../../lock.js";
import { reviewerIdOf } from "../../auth.js";

function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(process.cwd(), "..");
}

export function lockTestRouter(): Router {
  const router = Router();

  // Start a lock-test run: snapshot the current guideline sha, kick off the
  // agent batch run on the LOCK cohort, persist the manifest with the
  // resulting agent_run_id.
  router.post("/api/lock-test/:taskId/start", async (req, res) => {
    const { taskId } = req.params;
    const startedBy = (req.body?.started_by as string) ?? reviewerIdOf(req);

    const cohort = readCohortSampling(taskId);
    if (!cohort || cohort.lock_patient_ids.length === 0) {
      return res.status(400).json({ error: "no_lock_cohort" });
    }
    const guidelineSha = computeTaskSha(guidelineDir(taskId));

    const manifest = startLockTest({ taskId, startedBy, guidelineSha });

    // Kick off the agent batch run on the LOCK cohort.
    try {
      const result = startBatchRun({
        task_id: taskId,
        patient_ids: cohort.lock_patient_ids,
        started_by: startedBy,
        label: `lock_test:${manifest.run_id}`,
      });
      writeLockTestManifest(taskId, { ...manifest, agent_run_id: result.run_id });
      return res.json({ run_id: manifest.run_id, agent_run_id: result.run_id });
    } catch (err) {
      return res.status(500).json({
        error: "agent_run_start_failed",
        detail: String(err instanceof Error ? err.message : err),
      });
    }
  });

  router.get("/api/lock-test/:taskId", (req, res) => {
    res.json(listLockTests(req.params.taskId));
  });

  router.post("/api/lock-test/:taskId/:runId/finalize", (req, res) => {
    const { taskId, runId } = req.params;
    const rootDir = platformRoot();

    const m = readLockTestManifest(taskId, runId);
    if (!m) return res.status(404).json({ error: "no_lock_test_run" });

    const cohort = readCohortSampling(taskId);
    if (!cohort) return res.status(400).json({ error: "no_cohort" });

    const primaryCriterionIds = readPrimaryCriterionIds(taskId);
    const accuracy = computeIterAccuracy({
      rootDir,
      taskId,
      iterId: runId,
      cohortKind: "lock",
      patientIds: cohort.lock_patient_ids,
      primaryCriterionIds,
    });
    const updated = finalizeLockTest({ taskId, runId, accuracy });
    res.json({ manifest: updated, accuracy });
  });

  // Detail endpoint used by the lock-test row UI (T17). Reads each patient's
  // review_state.json directly to compute oracle/agent progress flags, plus
  // the optional accuracy.json that finalize writes.
  router.get("/api/lock-test/:taskId/:runId/detail", (req, res) => {
    const { taskId, runId } = req.params;
    const rootDir = platformRoot();

    const manifest = readLockTestManifest(taskId, runId);
    if (!manifest) return res.status(404).json({ error: "no_lock_test_run" });

    const cohort = readCohortSampling(taskId);
    if (!cohort) return res.status(400).json({ error: "no_cohort" });

    // Per-patient progress: read each patient's review_state.json for this task.
    const patients = cohort.lock_patient_ids.map((pid) => {
      const reviewPath = path.join(rootDir, "reviews", pid, taskId, "review_state.json");
      if (!fs.existsSync(reviewPath)) {
        return { patient_id: pid, oracle_done: false, in_progress: false, agent_done: false };
      }
      const state = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
      const reviewerTouched = (state.field_assessments ?? []).some((fa: any) => fa.source === "reviewer");
      const validated = state.review_status === "reviewer_validated" || state.review_status === "locked";
      const agentDone = (state.field_assessments ?? []).some((fa: any) => fa.source === "agent");
      return {
        patient_id: pid,
        oracle_done: validated,
        in_progress: reviewerTouched && !validated,
        agent_done: agentDone,
      };
    });

    // Optional accuracy block (only present after finalize).
    let accuracy: unknown = null;
    const accPath = path.join(guidelineDir(taskId), "lock_test", runId, "accuracy.json");
    if (fs.existsSync(accPath)) {
      accuracy = JSON.parse(fs.readFileSync(accPath, "utf8"));
    }

    res.json({ manifest, patients, accuracy });
  });

  return router;
}
