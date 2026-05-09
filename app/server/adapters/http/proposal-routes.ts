/**
 * adapters/http/proposal-routes — HTTP adapter for the RuleProposal lifecycle:
 * NL-rule translation, list/read, before/after diff preview, accept (promote
 * to live guideline), reject (with structured reason), and the opt-in
 * LLM-sampled replay for prose edits.
 *
 * Reviewers translate + submit proposals; methodologists accept or reject.
 * Accept and reject both fire reviewer-inbox notifications (#15) so the
 * proposer learns the outcome asynchronously.
 *
 * Routes registered:
 *   POST   /api/rules/:taskId/translate
 *   POST   /api/rules/:taskId/submit
 *   GET    /api/rules/:taskId
 *   GET    /api/rules/:taskId/:ruleId/preview-diff
 *   POST   /api/rules/:taskId/:ruleId/accept
 *   POST   /api/rules/:taskId/:ruleId/reject
 *   POST   /api/rules/:taskId/:ruleId/sample-replay
 *   POST   /api/proposals/:taskId/:ruleId/verify [DEFERRED]
 *     — Defined in domain/proposal/verify-application.ts.
 *     — See plan at chart-review-platform/docs/superpowers/plans/2026-05-05-iter-graduation-gates.md Task 1 Step 5.
 *     — Endpoint wiring deferred pending clean single-criterion-rerun export.
 */

import express, { Router } from "express";
import fs from "fs";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  translateRule,
  replayRule,
  writeProposal,
  readProposal,
  transitionStatus,
  type RuleProposal,
  listProposals,
  type RuleStatus,
  type ProposedEdit,
  promoteRule,
  sampleReplay,
} from "../../domain/proposal/index.js";
import { loadSkillBundle, guidelineDir } from "../../domain/rubric/index.js";
import { REVIEWS_ROOT } from "../../domain/review/index.js";
import { computeTaskSha } from "../../lock.js";
import { notify } from "../../notifications.js";
import { reviewerIdOf } from "../../auth.js";

// Structured rejection reasons (#44). Stored on the proposal so rejections
// become a queryable critique signal: cluster reasons, identify systematic
// issues with the proposal driver, etc.
const VALID_REJECT_REASONS = [
  "duplicate",
  "too_narrow",
  "too_broad",
  "wrong_field",
  "low_quality",
  "other",
] as const;
type RejectReason = (typeof VALID_REJECT_REASONS)[number];

export function proposalRouter(): Router {
  const router = Router();

  router.post("/api/rules/:taskId/translate", express.json(), async (req, res) => {
    const { taskId } = req.params as { taskId: string };
    const { nl_rule, override, expected_outcome, created_by } = req.body as {
      nl_rule?: string;
      override?: { record_id: string; agent_answer: unknown; reviewer_answer: unknown };
      expected_outcome?: RuleProposal["expected_outcome"];
      created_by?: string;
    };
    if (!nl_rule) {
      res.status(400).json({ ok: false, error: "nl_rule required" });
      return;
    }

    let bundle;
    try { bundle = loadSkillBundle(taskId); }
    catch (e) { res.status(404).json({ ok: false, error: `bundle not found: ${(e as Error).message}` }); return; }

    const ruleId = `rule-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 10)}`;

    const tx = await translateRule({ bundle, override, nl_rule });
    if (!tx.ok) {
      res.status(200).json({ ok: false, error: tx.error, rule_id: ruleId });
      return;
    }

    const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(process.cwd(), "..");
    const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(platformRoot, "reviews");
    const fromSha = computeTaskSha(guidelineDir(taskId));
    const replay = await replayRule({ taskId, fromSha, edit: tx.edit, reviewsRoot });

    const proposal: RuleProposal = {
      rule_id: ruleId,
      task_id: taskId,
      field_id: tx.edit.field_id,
      status: "draft",
      created_at: new Date().toISOString(),
      created_by: created_by ?? "anonymous",
      nl_rule,
      ...(override && { trigger: { type: "override", patient_id: override.record_id, agent_answer: override.agent_answer, reviewer_answer: override.reviewer_answer } }),
      proposed_edit: tx.edit,
      replay,
      ...(expected_outcome && { expected_outcome }),
    };
    writeProposal(proposal);

    res.json({ ok: true, proposal });
  });

  router.post("/api/rules/:taskId/submit", express.json(), (req, res) => {
    const { taskId } = req.params as { taskId: string };
    const { rule_id } = req.body as { rule_id?: string };
    if (!rule_id) { res.status(400).json({ ok: false, error: "rule_id required" }); return; }
    const proposal = readProposal(taskId, rule_id);
    if (!proposal) { res.status(404).json({ ok: false, error: "proposal not found" }); return; }
    try {
      const updated = transitionStatus(taskId, rule_id, "pending_methodologist_review");
      res.json({ ok: true, proposal: updated });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  // GET /api/rules/:taskId — list proposals with optional status filter
  router.get("/api/rules/:taskId", (req, res) => {
    const { taskId } = req.params as { taskId: string };
    const { status } = req.query as { status?: RuleStatus };
    const proposals = listProposals(taskId, status ? { status } : {});
    res.json(proposals);
  });

  // GET /api/rules/:taskId/:ruleId/preview-diff — render the current criterion
  // YAML and a simulated post-apply YAML so the methodologist sees the literal
  // before/after change before accepting.
  router.get("/api/rules/:taskId/:ruleId/preview-diff", (req, res) => {
    const { taskId, ruleId } = req.params as { taskId: string; ruleId: string };
    const proposal = readProposal(taskId, ruleId);
    if (!proposal) return res.status(404).json({ error: "proposal not found" });
    const edit = proposal.proposed_edit;
    const fieldId = edit?.field_id ?? proposal.field_id;
    const fieldPath = path.join(guidelineDir(taskId), "criteria", `${fieldId}.yaml`);
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
      } catch {
        /* fall through to identity */
      }
    }
    res.json({ before, after, field_id: fieldId });
  });

  // POST /api/rules/:taskId/:ruleId/accept
  router.post("/api/rules/:taskId/:ruleId/accept", express.json(), async (req, res) => {
    const { taskId, ruleId } = req.params as { taskId: string; ruleId: string };
    const { methodologist_edit, methodologist_id } = req.body as {
      methodologist_edit?: ProposedEdit;
      methodologist_id?: string;
    };
    // Capture the proposer BEFORE promote rewrites the proposal status —
    // promote sets status="applied" but `created_by` stays the same.
    const before = readProposal(taskId, ruleId);

    // #26 — recompute replay against the current SHA so promote uses fresh
    // flip data. The proposal's stored replay was computed at submit time;
    // records may have been locked since.
    let replayDrift: {
      before_flips: number;
      now_flips: number;
      before_total: number;
      now_total: number;
    } | null = null;
    try {
      const editToReplay = methodologist_edit ?? before?.proposed_edit;
      if (before && editToReplay) {
        const fromSha = computeTaskSha(guidelineDir(taskId));
        const fresh = await replayRule({
          taskId,
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
        // Update proposal so promote sees the fresh flips list.
        writeProposal({ ...before, replay: fresh });
      }
    } catch {
      /* best-effort — fall through to promote with the existing snapshot */
    }

    try {
      const result = await promoteRule({
        taskId, ruleId,
        methodologistId: methodologist_id ?? "anonymous",
        methodologistEdit: methodologist_edit,
      });
      if (before?.created_by) {
        notify({
          recipient_id: before.created_by,
          kind: "rule_accepted",
          message: `Your rule proposal ${ruleId} on ${taskId}/${before.field_id} was accepted. New SHA: ${String(result.resultingSha).slice(0, 8)}.`,
          link: `/methodologist/${taskId}`,
          task_id: taskId,
          rule_id: ruleId,
          metadata: { resulting_sha: result.resultingSha },
        });
      }
      res.json({ ok: true, ...result, replay_drift: replayDrift });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  // POST /api/rules/:taskId/:ruleId/reject
  // #44 — accepts a structured `reason` + optional `comment`. Both are stored
  // on the proposal itself so the rejection becomes a queryable critique
  // signal (cluster reasons, identify systematic problems with the proposal
  // driver, etc.). `reason` is required so the dataset stays clean.
  router.post("/api/rules/:taskId/:ruleId/reject", express.json(), (req, res) => {
    const { taskId, ruleId } = req.params as { taskId: string; ruleId: string };
    const reviewerId = reviewerIdOf(req);
    const reason = req.body?.reason as RejectReason | undefined;
    const comment = req.body?.comment as string | undefined;
    if (!reason || !VALID_REJECT_REASONS.includes(reason)) {
      return res.status(400).json({
        ok: false,
        error: `reason required, one of: ${VALID_REJECT_REASONS.join(", ")}`,
      });
    }
    const before = readProposal(taskId, ruleId);
    try {
      const updated = transitionStatus(taskId, ruleId, "rejected");
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
            `Your rule proposal ${ruleId} on ${taskId}/${before.field_id} was rejected ` +
            `(${reason}${comment ? ": " + comment.slice(0, 80) : ""}).`,
          link: `/methodologist/${taskId}`,
          task_id: taskId,
          rule_id: ruleId,
        });
      }
      res.json({ ok: true, proposal: updated });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  // POST /api/rules/:taskId/:ruleId/sample-replay (opt-in LLM)
  router.post("/api/rules/:taskId/:ruleId/sample-replay", express.json(), async (req, res) => {
    const { taskId, ruleId } = req.params as { taskId: string; ruleId: string };
    const { sample_size = 5 } = req.body as { sample_size?: number };
    const proposal = readProposal(taskId, ruleId);
    if (!proposal) { res.status(404).json({ ok: false, error: "proposal not found" }); return; }
    if (!proposal.proposed_edit || proposal.proposed_edit.edit_type !== "guidance_prose_append") {
      res.status(400).json({ ok: false, error: "sample-replay only supported for prose edits" });
      return;
    }
    const candidatePatientIds = (proposal.replay?.flips ?? []).map((f) => f.record_id);
    const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(process.cwd(), "..");

    const result = await sampleReplay({
      taskId,
      edit: proposal.proposed_edit,
      candidatePatientIds,
      sampleSize: sample_size,
      reviewsRoot: process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(platformRoot, "reviews"),
      corpusRoot: process.env.CHART_REVIEW_CORPUS_ROOT ?? path.join(platformRoot, "corpus"),
    });

    proposal.llm_sample_replay = result;
    writeProposal(proposal);
    res.json({ ok: true, proposal });
  });

  return router;
}
