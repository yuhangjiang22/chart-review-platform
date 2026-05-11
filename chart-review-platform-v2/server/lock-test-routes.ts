// M4 — Lock-test routes ported from v1's lock-test-routes.ts.
//
// 4 endpoints under /api/lock-test/:taskId/...
//   POST   :taskId/start            — kick off agent batch on LOCK cohort
//   GET    :taskId                  — list lock-test runs
//   POST   :taskId/:runId/finalize  — compute per-criterion accuracy
//   GET    :taskId/:runId/detail    — per-patient progress + accuracy

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { readReviewerFromRequest } from "./auth.js";
import {
  startLockTest, finalizeLockTest, listLockTests,
  readLockTestManifest, writeLockTestManifest,
} from "../../chart-review-platform/app/server/lock-test.js";
import { readCohortSampling } from "../../chart-review-platform/app/server/domain/cohort/index.js";
import {
  readPrimaryCriterionIds, computeIterAccuracy,
} from "../../chart-review-platform/app/server/domain/iter/index.js";
import { startBatchRun } from "../../chart-review-platform/app/server/infra/batch-run/index.js";
import { guidelineDir } from "../../chart-review-platform/app/server/domain/rubric/index.js";
import { computeTaskSha } from "../../chart-review-platform/app/server/lock.js";

function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT
    ?? path.resolve(process.cwd(), "..", "chart-review-platform");
}

function httpErr(status: number, message: string, payload?: unknown): Error & { status: number; payload?: unknown } {
  const err = new Error(message) as Error & { status: number; payload?: unknown };
  err.status = status;
  if (payload) err.payload = payload;
  return err;
}

export const lockTestRoutes: RouteEntry[] = [
  // POST /api/lock-test/:taskId/start
  {
    method: "POST", pattern: "/api/lock-test/:taskId/start",
    handler: async (body, req, p) => {
      const startedBy =
        (body as { started_by?: string })?.started_by
        ?? readReviewerFromRequest(req)
        ?? "anonymous-reviewer";

      const cohort = readCohortSampling(p.taskId);
      if (!cohort || cohort.lock_patient_ids.length === 0) {
        throw httpErr(400, "no_lock_cohort");
      }
      const guidelineSha = computeTaskSha(guidelineDir(p.taskId));
      const manifest = startLockTest({ taskId: p.taskId, startedBy, guidelineSha });

      try {
        const result = startBatchRun({
          task_id: p.taskId,
          patient_ids: cohort.lock_patient_ids,
          started_by: startedBy,
          label: `lock_test:${manifest.run_id}`,
        });
        writeLockTestManifest(p.taskId, { ...manifest, agent_run_id: result.run_id });
        return { run_id: manifest.run_id, agent_run_id: result.run_id };
      } catch (err) {
        throw httpErr(500, "agent_run_start_failed", {
          detail: String(err instanceof Error ? err.message : err),
        });
      }
    },
  },

  // GET /api/lock-test/:taskId
  {
    method: "GET", pattern: "/api/lock-test/:taskId",
    handler: async (_b, _r, p) => listLockTests(p.taskId),
  },

  // POST /api/lock-test/:taskId/:runId/finalize
  {
    method: "POST", pattern: "/api/lock-test/:taskId/:runId/finalize",
    handler: async (_b, _r, p) => {
      const rootDir = platformRoot();
      const m = readLockTestManifest(p.taskId, p.runId);
      if (!m) throw httpErr(404, "no_lock_test_run");

      const cohort = readCohortSampling(p.taskId);
      if (!cohort) throw httpErr(400, "no_cohort");

      const primaryCriterionIds = readPrimaryCriterionIds(p.taskId);
      const accuracy = computeIterAccuracy({
        rootDir,
        taskId: p.taskId,
        iterId: p.runId,
        cohortKind: "lock",
        patientIds: cohort.lock_patient_ids,
        primaryCriterionIds,
      });
      const updated = finalizeLockTest({ taskId: p.taskId, runId: p.runId, accuracy });
      return { manifest: updated, accuracy };
    },
  },

  // GET /api/lock-test/:taskId/:runId/detail
  {
    method: "GET", pattern: "/api/lock-test/:taskId/:runId/detail",
    handler: async (_b, _r, p) => {
      const rootDir = platformRoot();
      const manifest = readLockTestManifest(p.taskId, p.runId);
      if (!manifest) throw httpErr(404, "no_lock_test_run");

      const cohort = readCohortSampling(p.taskId);
      if (!cohort) throw httpErr(400, "no_cohort");

      const reviewsRootDir = process.env.CHART_REVIEW_REVIEWS_ROOT
        ?? path.join(rootDir, "var", "reviews");

      const patients = cohort.lock_patient_ids.map((pid) => {
        const reviewPath = path.join(reviewsRootDir, pid, p.taskId, "review_state.json");
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

      let accuracy: unknown = null;
      const accPath = path.join(guidelineDir(p.taskId), "lock_test", p.runId, "accuracy.json");
      if (fs.existsSync(accPath)) {
        accuracy = JSON.parse(fs.readFileSync(accPath, "utf8"));
      }
      return { manifest, patients, accuracy };
    },
  },
];
