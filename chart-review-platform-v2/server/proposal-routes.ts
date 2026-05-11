// M3 — Rule proposal routes ported from v1's proposal-routes.ts.
//
// 7 endpoints under /api/rules/:taskId/...
//   POST   /api/rules/:taskId/translate
//   POST   /api/rules/:taskId/submit
//   GET    /api/rules/:taskId
//   GET    /api/rules/:taskId/:ruleId/preview-diff
//   POST   /api/rules/:taskId/:ruleId/accept
//   POST   /api/rules/:taskId/:ruleId/reject
//   POST   /api/rules/:taskId/:ruleId/sample-replay
//
// Auth fidelity: v1 doesn't gate accept on isMethodologist — it takes
// `methodologist_id` from the body. Reject uses reviewerIdOf (already
// authenticated via the existing auth context). We mirror v1 byte for
// byte for the M3 port; tightening accept's gate is a follow-up.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RouteEntry } from "./router.js";
import { readReviewerFromRequest } from "./auth.js";

import {
  translateRule,
  replayRule,
  writeProposal,
  readProposal,
  transitionStatus,
  listProposals,
  promoteRule,
  sampleReplay,
  type RuleProposal,
  type RuleStatus,
  type ProposedEdit,
} from "../../chart-review-platform/app/server/domain/proposal/index.js";
import { loadSkillBundle, guidelineDir } from "../../chart-review-platform/app/server/domain/rubric/index.js";
import { REVIEWS_ROOT } from "../../chart-review-platform/app/server/domain/review/index.js";
import { computeTaskSha } from "../../chart-review-platform/app/server/lock.js";
import { notify } from "../../chart-review-platform/app/server/notifications.js";

/** Structured rejection reasons (#44). Stored on the proposal so
 *  rejections become a queryable critique signal. */
const VALID_REJECT_REASONS = [
  "duplicate", "too_narrow", "too_broad",
  "wrong_field", "low_quality", "other",
] as const;
type RejectReason = (typeof VALID_REJECT_REASONS)[number];

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export const proposalRoutes: RouteEntry[] = [
  // POST /api/rules/:taskId/translate — NL → DSL edit + replay snapshot
  {
    method: "POST", pattern: "/api/rules/:taskId/translate",
    handler: async (body, _req, p) => {
      const { nl_rule, override, expected_outcome, created_by } = (body ?? {}) as {
        nl_rule?: string;
        override?: { record_id: string; agent_answer: unknown; reviewer_answer: unknown };
        expected_outcome?: RuleProposal["expected_outcome"];
        created_by?: string;
      };
      if (!nl_rule) throw httpErr(400, "nl_rule required");

      let bundle;
      try { bundle = loadSkillBundle(p.taskId); }
      catch (e) { throw httpErr(404, `bundle not found: ${(e as Error).message}`); }

      const ruleId = `rule-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 10)}`;

      const tx = await translateRule({ bundle, override, nl_rule });
      if (!tx.ok) return { ok: false, error: tx.error, rule_id: ruleId };

      const fromSha = computeTaskSha(guidelineDir(p.taskId));
      const replay = await replayRule({
        taskId: p.taskId,
        fromSha,
        edit: tx.edit,
        reviewsRoot: REVIEWS_ROOT,
      });

      const proposal: RuleProposal = {
        rule_id: ruleId,
        task_id: p.taskId,
        field_id: tx.edit.field_id,
        status: "draft",
        created_at: new Date().toISOString(),
        created_by: created_by ?? "anonymous",
        nl_rule,
        ...(override && {
          trigger: {
            type: "override",
            patient_id: override.record_id,
            agent_answer: override.agent_answer,
            reviewer_answer: override.reviewer_answer,
          },
        }),
        proposed_edit: tx.edit,
        replay,
        ...(expected_outcome && { expected_outcome }),
      };
      writeProposal(proposal);
      return { ok: true, proposal };
    },
  },

  // POST /api/rules/:taskId/submit — draft → pending_methodologist_review
  {
    method: "POST", pattern: "/api/rules/:taskId/submit",
    handler: async (body, _req, p) => {
      const { rule_id } = (body ?? {}) as { rule_id?: string };
      if (!rule_id) throw httpErr(400, "rule_id required");
      const proposal = readProposal(p.taskId, rule_id);
      if (!proposal) throw httpErr(404, "proposal not found");
      try {
        const updated = transitionStatus(p.taskId, rule_id, "pending_methodologist_review");
        return { ok: true, proposal: updated };
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },

  // GET /api/rules/:taskId — list proposals (optional ?status= filter)
  {
    method: "GET", pattern: "/api/rules/:taskId",
    handler: async (_body, _req, p, query) => {
      const status = query.get("status") as RuleStatus | null;
      return listProposals(p.taskId, status ? { status } : {});
    },
  },

  // GET /api/rules/:taskId/:ruleId/preview-diff — before/after YAML render
  {
    method: "GET", pattern: "/api/rules/:taskId/:ruleId/preview-diff",
    handler: async (_body, _req, p) => {
      const proposal = readProposal(p.taskId, p.ruleId);
      if (!proposal) throw httpErr(404, "proposal not found");
      const edit = proposal.proposed_edit;
      const fieldId = edit?.field_id ?? proposal.field_id;
      const fieldPath = path.join(guidelineDir(p.taskId), "criteria", `${fieldId}.yaml`);
      const before = fs.existsSync(fieldPath) ? fs.readFileSync(fieldPath, "utf8") : "";
      let after = before;
      if (edit) {
        try {
          const parsed = (parseYaml(before) ?? {}) as Record<string, unknown>;
          if (edit.edit_type === "is_applicable_when_replace") {
            parsed.is_applicable_when = edit.payload;
          } else if (edit.edit_type === "guidance_prose_append") {
            const gp = (parsed.guidance_prose ?? {}) as { definition?: string };
            parsed.guidance_prose = {
              ...gp,
              definition: `${gp.definition ?? ""}\n\n${edit.payload}`,
            };
          }
          after = stringifyYaml(parsed);
        } catch { /* fall through to identity */ }
      }
      return { before, after, field_id: fieldId };
    },
  },

  // POST /api/rules/:taskId/:ruleId/accept — promote, recompute replay,
  // fire reviewer-inbox notification on success
  {
    method: "POST", pattern: "/api/rules/:taskId/:ruleId/accept",
    handler: async (body, _req, p) => {
      const { methodologist_edit, methodologist_id } = (body ?? {}) as {
        methodologist_edit?: ProposedEdit;
        methodologist_id?: string;
      };
      const before = readProposal(p.taskId, p.ruleId);

      // #26 — recompute replay against the current SHA so promote sees
      // fresh flips. Best-effort; promote still works on the stale snapshot.
      let replayDrift: {
        before_flips: number;
        now_flips: number;
        before_total: number;
        now_total: number;
      } | null = null;
      try {
        const editToReplay = methodologist_edit ?? before?.proposed_edit;
        if (before && editToReplay) {
          const fromSha = computeTaskSha(guidelineDir(p.taskId));
          const fresh = await replayRule({
            taskId: p.taskId,
            fromSha,
            edit: editToReplay,
            reviewsRoot: REVIEWS_ROOT,
          });
          replayDrift = {
            before_flips: before.replay?.flip_count ?? 0,
            now_flips: fresh.flip_count,
            before_total: before.replay?.total_locked ?? 0,
            now_total: fresh.total_locked,
          };
          writeProposal({ ...before, replay: fresh });
        }
      } catch { /* best-effort */ }

      try {
        const result = await promoteRule({
          taskId: p.taskId,
          ruleId: p.ruleId,
          methodologistId: methodologist_id ?? "anonymous",
          methodologistEdit: methodologist_edit,
        });
        if (before?.created_by) {
          notify({
            recipient_id: before.created_by,
            kind: "rule_accepted",
            message:
              `Your rule proposal ${p.ruleId} on ${p.taskId}/${before.field_id} was accepted. ` +
              `New SHA: ${String(result.resultingSha).slice(0, 8)}.`,
            link: `/methodologist/${p.taskId}`,
            task_id: p.taskId,
            rule_id: p.ruleId,
            metadata: { resulting_sha: result.resultingSha },
          });
        }
        return { ok: true, ...result, replay_drift: replayDrift };
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },

  // POST /api/rules/:taskId/:ruleId/reject — structured rejection reason
  {
    method: "POST", pattern: "/api/rules/:taskId/:ruleId/reject",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const reason = (body as { reason?: RejectReason })?.reason;
      const comment = (body as { comment?: string })?.comment;
      if (!reason || !VALID_REJECT_REASONS.includes(reason)) {
        throw httpErr(400, `reason required, one of: ${VALID_REJECT_REASONS.join(", ")}`);
      }
      const before = readProposal(p.taskId, p.ruleId);
      try {
        const updated = transitionStatus(p.taskId, p.ruleId, "rejected");
        updated.rejected = {
          rejected_at: new Date().toISOString(),
          rejected_by: reviewerId,
          reason,
          comment: comment?.trim() ? comment.trim() : undefined,
        };
        writeProposal(updated);
        if (before?.created_by) {
          notify({
            recipient_id: before.created_by,
            kind: "rule_rejected",
            message:
              `Your rule proposal ${p.ruleId} on ${p.taskId}/${before.field_id} was rejected ` +
              `(${reason}${comment ? ": " + comment.slice(0, 80) : ""}).`,
            link: `/methodologist/${p.taskId}`,
            task_id: p.taskId,
            rule_id: p.ruleId,
          });
        }
        return { ok: true, proposal: updated };
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
    },
  },

  // POST /api/rules/:taskId/:ruleId/sample-replay (opt-in LLM)
  {
    method: "POST", pattern: "/api/rules/:taskId/:ruleId/sample-replay",
    handler: async (body, _req, p) => {
      const sample_size = (body as { sample_size?: number })?.sample_size ?? 5;
      const proposal = readProposal(p.taskId, p.ruleId);
      if (!proposal) throw httpErr(404, "proposal not found");
      if (!proposal.proposed_edit || proposal.proposed_edit.edit_type !== "guidance_prose_append") {
        throw httpErr(400, "sample-replay only supported for prose edits");
      }
      const candidatePatientIds = (proposal.replay?.flips ?? []).map((f) => f.record_id);
      const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT
        ?? path.resolve(process.cwd(), "..", "chart-review-platform");
      const result = await sampleReplay({
        taskId: p.taskId,
        edit: proposal.proposed_edit,
        candidatePatientIds,
        sampleSize: sample_size,
        reviewsRoot: process.env.CHART_REVIEW_REVIEWS_ROOT
          ?? path.join(platformRoot, "var", "reviews"),
        corpusRoot: process.env.CHART_REVIEW_CORPUS_ROOT
          ?? path.join(platformRoot, "corpus"),
      });
      proposal.llm_sample_replay = result;
      writeProposal(proposal);
      return { ok: true, proposal };
    },
  },
];
