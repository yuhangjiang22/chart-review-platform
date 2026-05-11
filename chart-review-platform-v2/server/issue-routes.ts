// M4 — Deployment-issues queue routes ported from v1's issue-routes.ts.
//
// 4 endpoints under /api/deployment-issues/:guidelineSha/...
//   POST   :sha              — file an issue (any authenticated reviewer)
//   GET    :sha              — list issues (methodologist)
//   POST   :sha/promote      — promote N issues to a new pilot iter (methodologist)
//   POST   :sha/:id/triage   — append a triage update (methodologist)

import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import {
  appendIssue, appendPromotion, appendTriageUpdate, listIssues,
  type DeploymentIssue,
} from "../../chart-review-platform/app/server/domain/issue/index.js";
import { startPilotIteration } from "../../chart-review-platform/app/server/domain/iter/index.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export const issueRoutes: RouteEntry[] = [
  // POST /api/deployment-issues/:guidelineSha — append an issue
  {
    method: "POST", pattern: "/api/deployment-issues/:guidelineSha",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!reviewerId) throw httpErr(401, "authentication required");
      const { patient_id, description, field_id, suggested_correction } =
        (body ?? {}) as {
          patient_id?: string; description?: string;
          field_id?: string; suggested_correction?: string;
        };
      if (!patient_id || !description) {
        throw httpErr(400, "patient_id and description are required");
      }
      try {
        return appendIssue({
          guideline_sha: p.guidelineSha,
          patient_id,
          field_id,
          reporter_id: reviewerId,
          description,
          suggested_correction,
        });
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },

  // GET /api/deployment-issues/:guidelineSha — list issues (methodologist)
  {
    method: "GET", pattern: "/api/deployment-issues/:guidelineSha",
    handler: async (_body, req, p) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "listing deployment issues requires methodologist privilege");
      }
      try {
        const issues = listIssues(p.guidelineSha);
        return { guideline_sha: p.guidelineSha, issues, n_total: issues.length };
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },

  // POST /api/deployment-issues/:guidelineSha/promote — N issues → new iter
  {
    method: "POST", pattern: "/api/deployment-issues/:guidelineSha/promote",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "promoting issues requires methodologist privilege");
      }
      const { issue_ids, task_id, started_by } = (body ?? {}) as {
        issue_ids?: string[]; task_id?: string; started_by?: string;
      };
      if (!Array.isArray(issue_ids) || issue_ids.length === 0) {
        throw httpErr(400, "issue_ids array is required and must be non-empty");
      }
      if (!task_id || typeof task_id !== "string") {
        throw httpErr(400, "task_id is required");
      }

      let issues: DeploymentIssue[];
      try { issues = listIssues(p.guidelineSha); }
      catch (e) { throw httpErr(400, (e as Error).message); }

      const byId = new Map(issues.map((i) => [i.issue_id, i] as const));
      const promotable: DeploymentIssue[] = [];
      const rejected: Array<{ issue_id: string; reason: string }> = [];
      for (const id of issue_ids) {
        const issue = byId.get(id);
        if (!issue) { rejected.push({ issue_id: id, reason: "not found" }); continue; }
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
        const err = httpErr(400, "no promotable issues in the request") as Error & { status: number; payload?: unknown };
        err.payload = { rejected };
        throw err;
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
          started_by: started_by || reviewerId!,
          notes: `Promoted from ${promotable.length} deployment issues against ${p.guidelineSha}`,
        });
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }

      // Stamp each promoted issue with the new iter_id. Non-fatal.
      for (const issue of promotable) {
        try {
          appendPromotion(p.guidelineSha, issue.issue_id, {
            promoted_to_iter: pilotResult.pilot.iter_id,
            promoted_by: reviewerId!,
          });
        } catch (e) {
          console.warn(`[promote-issues] failed to stamp ${issue.issue_id}: ${(e as Error).message}`);
        }
      }

      return {
        iter_id: pilotResult.pilot.iter_id,
        run_id: pilotResult.pilot.run_id,
        n_patients_promoted: patientIds.length,
        n_issues_promoted: promotable.length,
        rejected: rejected.length > 0 ? rejected : undefined,
      };
    },
  },

  // POST /api/deployment-issues/:guidelineSha/:issueId/triage
  {
    method: "POST", pattern: "/api/deployment-issues/:guidelineSha/:issueId/triage",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "triaging deployment issues requires methodologist privilege");
      }
      const { category, note, corrected_answer } = (body ?? {}) as {
        category?: string; note?: string; corrected_answer?: unknown;
      };
      if (!category) throw httpErr(400, "category is required");
      try {
        return appendTriageUpdate(p.guidelineSha, p.issueId, {
          category: category as Parameters<typeof appendTriageUpdate>[2]["category"],
          triaged_by: reviewerId!,
          note,
          corrected_answer,
        });
      } catch (e) {
        const msg = (e as Error).message;
        throw httpErr(/not found/.test(msg) ? 404 : 400, msg);
      }
    },
  },
];
