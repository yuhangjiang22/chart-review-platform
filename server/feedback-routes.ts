// M6.6 — Legacy /api/cohort/* (singular) routes. Distinct from the
// /api/cohorts/* (plural) deployment cohort surface ported in M4 —
// these are the cohort-feedback pipeline (Role C: agent reads every
// review_state.json for one task, proposes protocol revisions).
//
// Endpoints:
//   POST   /api/cohort/analyze                                 — run feedback agent
//   GET    /api/cohort/:taskId/feedback                        — latest result
//   GET    /api/cohort/:taskId/runs                            — list cohort runs
//   GET    /api/cohort/:taskId/runs/:runId                     — read one run
//   POST   /api/cohort/:taskId/runs/:runId/proposals/:proposalId/convert
//          — convert feedback proposal → standard rule proposal

import path from "node:path";
import type { RouteEntry } from "./router.js";
import { readReviewerFromRequest } from "./auth.js";
import {
  analyzeCohort, loadCohortFeedback,
  listCohortRuns as listFeedbackCohortRuns, readCohortRun,
} from "./lib/feedback.js";
import {
  translateRule, replayRule, writeProposal, transitionStatus,
  type RuleProposal,
} from "./lib/domain/proposal/index.js";
import {
  loadSkillBundle, guidelineDir,
} from "./lib/domain/rubric/index.js";
import { REVIEWS_ROOT } from "./lib/domain/review/index.js";
import { computeTaskSha } from "./lib/lock.js";

function httpErr(status: number, message: string, payload?: unknown): Error & { status: number; payload?: unknown } {
  const err = new Error(message) as Error & { status: number; payload?: unknown };
  err.status = status;
  if (payload) err.payload = payload;
  return err;
}

export const feedbackRoutes: RouteEntry[] = [
  // POST /api/cohort/analyze — run feedback agent across reviews
  {
    method: "POST", pattern: "/api/cohort/analyze",
    handler: async (body) => {
      const { task_id, member_ids } = (body ?? {}) as {
        task_id?: string; member_ids?: string[];
      };
      if (!task_id) throw httpErr(400, "task_id required");
      try {
        const result = await analyzeCohort({ task_id, member_ids });
        if (!result.ok) throw httpErr(500, (result as { error?: string }).error ?? "analyzeCohort failed", result);
        return result;
      } catch (e) {
        if ((e as { status?: number }).status) throw e;
        throw httpErr(500, (e as Error).message);
      }
    },
  },

  // GET /api/cohort/:taskId/feedback
  {
    method: "GET", pattern: "/api/cohort/:taskId/feedback",
    handler: async (_b, _r, p) => {
      const fb = loadCohortFeedback(p.taskId);
      if (fb === null) throw httpErr(404, "no feedback yet for this task");
      return fb;
    },
  },

  // GET /api/cohort/:taskId/runs
  {
    method: "GET", pattern: "/api/cohort/:taskId/runs",
    handler: async (_b, _r, p) => listFeedbackCohortRuns(p.taskId),
  },

  // GET /api/cohort/:taskId/runs/:runId
  {
    method: "GET", pattern: "/api/cohort/:taskId/runs/:runId",
    handler: async (_b, _r, p) => {
      const fb = readCohortRun(p.taskId, p.runId);
      if (fb === null) throw httpErr(404, "run not found");
      return fb;
    },
  },

  // POST /api/cohort/:taskId/runs/:runId/proposals/:proposalId/convert
  // Translate a feedback proposal into a standard rule proposal in
  // pending_methodologist_review state.
  {
    method: "POST", pattern: "/api/cohort/:taskId/runs/:runId/proposals/:proposalId/convert",
    handler: async (_body, req, p) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";

      const run = readCohortRun(p.taskId, p.runId) as { proposals?: Array<{
        proposal_id: string;
        category?: string;
        target_field?: string | string[] | null;
        proposal: string;
        rationale?: string;
        motivating_patients?: string[];
      }> } | null;
      if (!run) throw httpErr(404, "cohort run not found");
      const cp = run.proposals?.find((px) => px.proposal_id === p.proposalId);
      if (!cp) throw httpErr(404, "proposal not found in this run");

      let bundle;
      try { bundle = loadSkillBundle(p.taskId); }
      catch (e) { throw httpErr(404, `bundle not found: ${(e as Error).message}`); }

      const targetFieldHint = cp.target_field
        ? Array.isArray(cp.target_field)
          ? `target_field: ${cp.target_field.join(", ")}\n`
          : `target_field: ${cp.target_field}\n`
        : "";
      const categoryHint = cp.category ? `category: ${cp.category}\n` : "";
      const rationale = cp.rationale ? `\n\nRationale: ${cp.rationale}` : "";
      const motivating = cp.motivating_patients?.length
        ? `\n\nMotivating patients: ${cp.motivating_patients.join(", ")}`
        : "";
      const nlRule = `${categoryHint}${targetFieldHint}\n${cp.proposal}${rationale}${motivating}`.trim();

      const ruleId = `rule-${new Date().toISOString().slice(0, 10)}-from-${p.proposalId}`;
      const tx = await translateRule({ bundle, nl_rule: nlRule });
      if (!tx.ok) return { ok: false, error: tx.error, rule_id: ruleId };

      const fromSha = computeTaskSha(guidelineDir(p.taskId));
      const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT
        ?? path.resolve(process.cwd(), "..", "chart-review-platform");
      void platformRoot; // unused but documents env precedence
      const replay = await replayRule({
        taskId: p.taskId, fromSha, edit: tx.edit, reviewsRoot: REVIEWS_ROOT,
      });

      const proposal: RuleProposal = {
        rule_id: ruleId,
        task_id: p.taskId,
        field_id: tx.edit.field_id,
        status: "draft",
        created_at: new Date().toISOString(),
        created_by: reviewerId,
        nl_rule: nlRule,
        proposed_edit: tx.edit,
        replay,
        // v1 widens its trigger type via `as any`; mirror that — the
        // declared RuleProposal.trigger union doesn't include
        // cohort_feedback, but the store writes it through unchanged.
        trigger: {
          type: "cohort_feedback",
          run_id: p.runId,
          source_proposal_id: p.proposalId,
        } as unknown as RuleProposal["trigger"],
      };
      writeProposal(proposal);
      const submitted = transitionStatus(p.taskId, ruleId, "pending_methodologist_review");
      return { ok: true, proposal: submitted };
    },
  },
];
