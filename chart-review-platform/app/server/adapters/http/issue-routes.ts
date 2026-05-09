/**
 * adapters/http/issue-routes — HTTP adapter for the deployment-issues queue.
 *
 * Reviewers and clinical end-users surface field issues against a deployed
 * locked guideline. Issues are append-only per guideline_sha; the triage UI
 * consumes the list endpoint.
 *
 * Append: any authenticated reviewer may file an issue (the bar is "I noticed
 * something"). Listing requires methodologist privilege — the queue contains
 * reviewer comments that may name patients and aren't appropriate for a
 * general audience to browse.
 *
 * Routes registered:
 *   POST   /api/deployment-issues/:guidelineSha
 *   GET    /api/deployment-issues/:guidelineSha
 *   POST   /api/deployment-issues/:guidelineSha/promote
 *   POST   /api/deployment-issues/:guidelineSha/:issueId/triage
 */

import express, { Router } from "express";
import {
  appendIssue,
  appendPromotion,
  appendTriageUpdate,
  listIssues,
} from "../../domain/issue/index.js";
import { startPilotIteration } from "../../domain/iter/index.js";
import { reviewerIdOf, isMethodologist } from "../../auth.js";

export function issueRouter(): Router {
  const router = Router();

  /**
   * POST /api/deployment-issues/:guidelineSha
   *
   * Body: { patient_id, description, field_id?, suggested_correction? }
   *
   * Reporter is set from auth. Returns the persisted issue (with server-
   * generated issue_id and reported_at).
   */
  router.post("/api/deployment-issues/:guidelineSha", express.json(), (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!reviewerId) return res.status(401).json({ error: "authentication required" });

    const { guidelineSha } = req.params;
    const { patient_id, description, field_id, suggested_correction } = req.body ?? {};
    if (!patient_id || !description) {
      return res.status(400).json({ error: "patient_id and description are required" });
    }

    try {
      const issue = appendIssue({
        guideline_sha: guidelineSha,
        patient_id,
        field_id,
        reporter_id: reviewerId,
        description,
        suggested_correction,
      });
      res.status(201).json(issue);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * GET /api/deployment-issues/:guidelineSha
   *
   * Returns the full issue list in append order with the latest triage state
   * rolled up onto each issue. Methodologist-only.
   */
  router.get("/api/deployment-issues/:guidelineSha", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "listing deployment issues requires methodologist privilege" });
    }
    const { guidelineSha } = req.params;
    try {
      const issues = listIssues(guidelineSha);
      res.json({ guideline_sha: guidelineSha, issues, n_total: issues.length });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * POST /api/deployment-issues/:guidelineSha/promote
   *
   * Promote a batch of triaged issues into a new pilot iter. Methodologist
   * only.
   *
   * Body:
   *   { issue_ids: string[], task_id: string, started_by?: string }
   *
   * Behavior:
   * - Loads issues for the sha; resolves issue_ids → issues.
   * - Each issue must be triaged with category in {agent_error, guideline_gap}
   *   and not already promoted. Other categories surface as 400 with detail.
   * - Unique patient_ids across selected issues become dev_patient_ids of a
   *   new pilot iter via startPilotIteration().
   * - Each promoted issue gets a promotion record stamping the new iter_id.
   */
  router.post("/api/deployment-issues/:guidelineSha/promote", express.json(), (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "promoting issues requires methodologist privilege" });
    }
    const { guidelineSha } = req.params;
    const { issue_ids, task_id, started_by } = req.body ?? {};
    if (!Array.isArray(issue_ids) || issue_ids.length === 0) {
      return res.status(400).json({ error: "issue_ids array is required and must be non-empty" });
    }
    if (!task_id || typeof task_id !== "string") {
      return res.status(400).json({ error: "task_id is required" });
    }

    let issues;
    try {
      issues = listIssues(guidelineSha);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }

    const byId = new Map(issues.map((i) => [i.issue_id, i] as const));
    const promotable: typeof issues = [];
    const rejected: Array<{ issue_id: string; reason: string }> = [];
    for (const id of issue_ids) {
      const issue = byId.get(id);
      if (!issue) {
        rejected.push({ issue_id: id, reason: "not found" });
        continue;
      }
      if (issue.promoted) {
        rejected.push({ issue_id: id, reason: `already promoted to ${issue.promoted.promoted_to_iter}` });
        continue;
      }
      if (!issue.triage) {
        rejected.push({ issue_id: id, reason: "not triaged yet" });
        continue;
      }
      if (issue.triage.category !== "agent_error" && issue.triage.category !== "guideline_gap") {
        rejected.push({
          issue_id: id,
          reason: `triage category "${issue.triage.category}" is not promotable (only agent_error or guideline_gap)`,
        });
        continue;
      }
      promotable.push(issue);
    }

    if (promotable.length === 0) {
      return res.status(400).json({ error: "no promotable issues in the request", rejected });
    }

    // Dedupe patient_ids while preserving first-seen order.
    const seen = new Set<string>();
    const patientIds: string[] = [];
    for (const issue of promotable) {
      if (!seen.has(issue.patient_id)) {
        seen.add(issue.patient_id);
        patientIds.push(issue.patient_id);
      }
    }

    let pilotResult;
    try {
      pilotResult = startPilotIteration({
        task_id,
        patient_ids: patientIds,
        started_by: started_by || reviewerId,
        notes: `Promoted from ${promotable.length} deployment issues against ${guidelineSha}`,
      });
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }

    // Stamp each promoted issue with the new iter_id. Non-fatal if a stamp
    // fails — the pilot iter is already started.
    for (const issue of promotable) {
      try {
        appendPromotion(guidelineSha, issue.issue_id, {
          promoted_to_iter: pilotResult.pilot.iter_id,
          promoted_by: reviewerId,
        });
      } catch (e) {
        console.warn(`[promote-issues] failed to stamp ${issue.issue_id}: ${(e as Error).message}`);
      }
    }

    res.status(201).json({
      iter_id: pilotResult.pilot.iter_id,
      run_id: pilotResult.pilot.run_id,
      n_patients_promoted: patientIds.length,
      n_issues_promoted: promotable.length,
      rejected: rejected.length > 0 ? rejected : undefined,
    });
  });

  /**
   * POST /api/deployment-issues/:guidelineSha/:issueId/triage
   *
   * Append a triage update to the log. Methodologist-only.
   *
   * Body: { category, note?, corrected_answer? }
   *   category: dismiss | agent_error | data_issue | guideline_gap
   */
  router.post("/api/deployment-issues/:guidelineSha/:issueId/triage", express.json(), (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "triaging deployment issues requires methodologist privilege" });
    }
    const { guidelineSha, issueId } = req.params;
    const { category, note, corrected_answer } = req.body ?? {};
    if (!category) return res.status(400).json({ error: "category is required" });

    try {
      const triage = appendTriageUpdate(guidelineSha, issueId, {
        category,
        triaged_by: reviewerId,
        note,
        corrected_answer,
      });
      res.status(201).json(triage);
    } catch (e) {
      const msg = (e as Error).message;
      const status = /not found/.test(msg) ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  return router;
}
