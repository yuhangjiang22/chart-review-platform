import { Router } from "express";
import { stratifiedSample } from "./sampling.js";
import { PLATFORM_ROOT } from "./patients.js";
import path from "path";
import express from "express";

// Import the internal reviewsRoot function (not exported, but needed)
// Since reviewsRoot is not exported, we'll inline the logic here
import { REVIEWS_ROOT } from "./domain/review/index.js";
import { assignRecords, unassignRecords, getReviewerQueue } from "./assignment.js";

// Helper to get reviewsRoot (matches review-state.ts pattern)
function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

export function assignmentRouter(): Router {
  const r = Router();

  r.post("/api/sampling/:task_id", express.json(), async (req, res) => {
    const { task_id } = req.params as { task_id: string };
    const { sample_size, stratify_by = [], seed = 0 } = req.body as {
      sample_size: number;
      stratify_by?: string[];
      seed?: number;
    };
    if (!sample_size || sample_size < 1) {
      return res.status(400).json({ ok: false, error: "sample_size required, must be >= 1" });
    }
    const corpusRoot = path.join(PLATFORM_ROOT, "corpus");
    const result = stratifiedSample({
      taskId: task_id,
      reviewsRoot: REVIEWS_ROOT,
      patientCorpusRoot: corpusRoot,
      sampleSize: sample_size,
      stratifyBy: stratify_by,
      seed,
    });
    res.json({ ok: true, ...result });
  });

  // POST /api/assignments/:task_id - assign reviewers to records
  r.post("/api/assignments/:task_id", express.json(), async (req, res) => {
    const { task_id } = req.params as { task_id: string };
    const { patient_ids, reviewer_ids } = req.body as { patient_ids?: string[]; reviewer_ids?: string[] };
    if (!Array.isArray(patient_ids) || !Array.isArray(reviewer_ids)) {
      return res.status(400).json({ ok: false, error: "patient_ids[] and reviewer_ids[] required" });
    }
    const by = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";
    await assignRecords({ taskId: task_id, patientIds: patient_ids, reviewerIds: reviewer_ids, reviewsRoot: reviewsRoot() }, by);
    res.json({ ok: true });
  });

  // DELETE /api/assignments/:task_id - unassign reviewers from records
  r.delete("/api/assignments/:task_id", express.json(), async (req, res) => {
    const { task_id } = req.params as { task_id: string };
    const { patient_ids, reviewer_ids } = req.body as { patient_ids?: string[]; reviewer_ids?: string[] };
    if (!Array.isArray(patient_ids) || !Array.isArray(reviewer_ids)) {
      return res.status(400).json({ ok: false, error: "patient_ids[] and reviewer_ids[] required" });
    }
    const by = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";
    await unassignRecords({ taskId: task_id, patientIds: patient_ids, reviewerIds: reviewer_ids, reviewsRoot: reviewsRoot() }, by);
    res.json({ ok: true });
  });

  // GET /api/queue/me - get current reviewer's queue
  r.get("/api/queue/me", (req, res) => {
    const me = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";
    res.json(getReviewerQueue(me, reviewsRoot()));
  });

  // GET /api/queue/:reviewer_id - get specific reviewer's queue
  r.get("/api/queue/:reviewer_id", (req, res) => {
    const { reviewer_id } = req.params as { reviewer_id: string };
    res.json(getReviewerQueue(reviewer_id, reviewsRoot()));
  });

  return r;
}
