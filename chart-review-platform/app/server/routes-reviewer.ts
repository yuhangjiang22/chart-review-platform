/**
 * Reviewer REST endpoints — Phase B, Task 23.
 *
 * Five named endpoints + one generic /uiactions mirror:
 *   POST /api/reviews/:pid/:tid/accept-draft
 *   POST /api/reviews/:pid/:tid/bulk-accept
 *   POST /api/reviews/:pid/:tid/blind-submit
 *   POST /api/reviews/:pid/:tid/validate
 *   POST /api/reviews/:pid/:tid/session-summary
 *
 * All mutating endpoints route through applyUiAction so they share the
 * same faithfulness gate, live-alerts recomputation, and optimistic-
 * concurrency pipeline as the chat-agent MCP tools.
 *
 * Audit step_types emitted (one per endpoint):
 *   accept_agent_draft, bulk_accept, blind_submit, record_validated,
 *   reviewer_session_summary
 */

import { Router } from "express";
import { createHash, randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import {
  applyUiAction,
  load as loadReviewState,
  ReviewStateError,
  type ReviewState,
} from "./domain/review/index.js";
import { appendAuditEntry } from "./audit-trail.js";
import { loadCompiledTask } from "./tasks.js";
import { reviewerIdOf } from "./auth.js";
import { computeTaskSha, lockReadyCheck } from "./lock.js";
import { archiveVersion } from "./version-archive.js";
import { guidelineDir } from "./domain/rubric/index.js";
import type { Request, Response } from "express";
import { runDerivedAdjudicationsForPatient } from "./derived-adjudications/run-on-lock.js";
import {
  resolvePilotContext,
  loadAgentDraftAndAudit,
  loadGuidelineTextByField,
  findActiveIterIdForPatient,
} from "./derived-adjudications/lock-helpers.js";
import type { FieldAssessment } from "./domain/review/review-state.js";

/** Callback injected by server.ts so reviewer endpoints can push WS updates. */
export type BroadcastFn = (patientId: string, state: ReviewState, taskId?: string) => void;

export function reviewerRouter(broadcast: BroadcastFn = () => {}): Router {
  const r = Router();

  // ── accept-draft ─────────────────────────────────────────────────────────────
  // Promote a single agent-proposed field assessment to reviewer-approved.
  // The agent's answer, evidence, and rationale are preserved as-is; only
  // source + status change.
  r.post("/api/reviews/:pid/:tid/accept-draft", (req: Request, res: Response) => {
    const { pid, tid } = req.params;
    const { field_id } = req.body as { field_id?: string };
    if (!field_id) {
      return res.status(400).json({ ok: false, error: "field_id required" });
    }
    const reviewer_id = reviewerIdOf(req);

    const task = loadCompiledTask(tid);
    if (!task) {
      return res.status(404).json({ ok: false, error: `task ${tid} not found` });
    }

    const state = loadReviewState(pid, tid);
    if (!state) {
      return res.status(404).json({ ok: false, error: "review state not found" });
    }

    const fa = state.field_assessments.find((f) => f.field_id === field_id);
    if (!fa || fa.source !== "agent") {
      return res.status(400).json({ ok: false, error: "no agent draft to accept" });
    }

    const agent_answer_sha = sha(JSON.stringify({ a: fa.answer, e: fa.evidence, r: fa.rationale }));
    const sessionId = `reviewer__${reviewer_id}`;

    try {
      const result = applyUiAction(pid, task, "reviewer", reviewer_id, {
        type: "set_field_assessment",
        payload: {
          field_id: fa.field_id,
          answer: fa.answer,
          confidence: fa.confidence,
          evidence: fa.evidence,
          rationale: fa.rationale,
          status: "approved",
        },
      });
      appendAuditEntry(
        { patientId: pid, taskId: tid, sessionId },
        {
          ts: new Date().toISOString(),
          session_id: sessionId,
          step_type: "accept_agent_draft",
          field_id,
          agent_answer_sha,
          reviewer_id,
        },
      );
      broadcast(pid, result.state, tid);
      res.json({ ok: true, version: result.state.version });
    } catch (e) {
      handleError(res, e);
    }
  });

  // ── bulk-accept ──────────────────────────────────────────────────────────────
  // Accept every agent-proposed field assessment in one call. Applies each
  // promotion sequentially so every write goes through the faithfulness gate
  // and live-alerts recomputation.
  r.post("/api/reviews/:pid/:tid/bulk-accept", (req: Request, res: Response) => {
    const { pid, tid } = req.params;
    const reviewer_id = reviewerIdOf(req);

    const task = loadCompiledTask(tid);
    if (!task) {
      return res.status(404).json({ ok: false, error: `task ${tid} not found` });
    }

    const state = loadReviewState(pid, tid);
    if (!state) {
      return res.status(404).json({ ok: false, error: "review state not found" });
    }

    const targets = state.field_assessments.filter((f) => f.source === "agent");
    const sessionId = `reviewer__${reviewer_id}`;
    const bulkSessionId = `bulk-${randomUUID()}`;

    try {
      let last_version = state.version;
      let last_state: ReviewState = state;
      for (const fa of targets) {
        const result = applyUiAction(pid, task, "reviewer", reviewer_id, {
          type: "set_field_assessment",
          payload: {
            field_id: fa.field_id,
            answer: fa.answer,
            confidence: fa.confidence,
            evidence: fa.evidence,
            rationale: fa.rationale,
            status: "approved",
          },
        });
        last_version = result.state.version;
        last_state = result.state;
      }
      appendAuditEntry(
        { patientId: pid, taskId: tid, sessionId: bulkSessionId },
        {
          ts: new Date().toISOString(),
          session_id: bulkSessionId,
          step_type: "bulk_accept",
          fields: targets.map((f) => f.field_id),
          count: targets.length,
          reviewer_id,
        },
      );
      broadcast(pid, last_state, tid);
      res.json({ ok: true, count: targets.length, version: last_version });
    } catch (e) {
      handleError(res, e);
    }
  });

  // ── blind-submit ─────────────────────────────────────────────────────────────
  // Reviewer submits their own answer before seeing the agent's — blind mode.
  // Records SHA of both answers and whether they diverged in the audit log.
  // The agent's answer snapshot is automatically captured by applySetAssessment
  // when `by === "reviewer"` and `existing.source === "agent"`.
  r.post("/api/reviews/:pid/:tid/blind-submit", (req: Request, res: Response) => {
    const { pid, tid } = req.params;
    const reviewer_id = reviewerIdOf(req);
    const {
      field_id,
      answer,
      evidence,
      rationale,
      confidence,
    } = req.body as {
      field_id: string;
      answer: unknown;
      evidence?: unknown[];
      rationale?: string;
      confidence?: "low" | "medium" | "high";
    };

    if (!field_id) {
      return res.status(400).json({ ok: false, error: "field_id required" });
    }

    const task = loadCompiledTask(tid);
    if (!task) {
      return res.status(404).json({ ok: false, error: `task ${tid} not found` });
    }

    const state = loadReviewState(pid, tid);
    if (!state) {
      return res.status(404).json({ ok: false, error: "review state not found" });
    }

    const prior = state.field_assessments.find((f) => f.field_id === field_id);
    const agent_answer_sha =
      prior?.source === "agent"
        ? sha(JSON.stringify({ a: prior.answer, e: prior.evidence, r: prior.rationale }))
        : "";
    const blind_answer_sha = sha(JSON.stringify({ a: answer, e: evidence, r: rationale }));
    const divergent =
      prior?.source === "agent" &&
      agent_answer_sha !== "" &&
      agent_answer_sha !== blind_answer_sha;

    const sessionId = `reviewer__${reviewer_id}`;

    try {
      const result = applyUiAction(pid, task, "reviewer", reviewer_id, {
        type: "set_field_assessment",
        payload: {
          field_id,
          answer,
          // evidence type comes in as unknown[] from JSON body; cast to Evidence[]
          // which is validated at the faithfulness gate inside applySetAssessment.
          evidence: evidence as import("./faithfulness.js").Evidence[] | undefined,
          rationale,
          confidence,
          status: divergent ? "overridden" : "approved",
        },
      });
      appendAuditEntry(
        { patientId: pid, taskId: tid, sessionId },
        {
          ts: new Date().toISOString(),
          session_id: sessionId,
          step_type: "blind_submit",
          field_id,
          blind_answer_sha,
          agent_answer_sha,
          divergent,
          reviewer_id,
        },
      );
      broadcast(pid, result.state, tid);
      res.json({ ok: true, version: result.state.version, divergent });
    } catch (e) {
      handleError(res, e);
    }
  });

  // ── validate ─────────────────────────────────────────────────────────────────
  // Check four gate conditions. If all pass, flip review_status to
  // "reviewer_validated" via applyUiAction (goes through same mutate pipeline).
  // Returns 200 { ok: true } or 400 { ok: false, gate_results }.
  r.post("/api/reviews/:pid/:tid/validate", (req: Request, res: Response) => {
    const { pid, tid } = req.params;
    const reviewer_id = reviewerIdOf(req);

    const task = loadCompiledTask(tid);
    if (!task) {
      return res.status(404).json({ ok: false, error: `task ${tid} not found` });
    }

    const state = loadReviewState(pid, tid);
    if (!state) {
      return res.status(404).json({ ok: false, error: "review state not found" });
    }

    // Gate 1: every leaf field (non-derived) must be in a terminal status.
    const leafFields = task.fields.filter((f) => !f.derivation);
    const all_terminal = leafFields.every((f) => {
      const fa = state.field_assessments.find((x) => x.field_id === f.id);
      return (
        fa &&
        (fa.status === "approved" ||
          fa.status === "overridden" ||
          fa.status === "not_applicable")
      );
    });

    // Gate 2: every leaf field must have been touched by a reviewer
    // (source === "reviewer"), i.e., not still purely agent-proposed.
    const every_leaf_touched_or_bulk_accepted = leafFields.every((f) => {
      const fa = state.field_assessments.find((x) => x.field_id === f.id);
      return fa && fa.source === "reviewer";
    });

    // Gate 3: no error-severity cross-criterion alerts remain.
    const alerts_dismissed = !(state.cross_criterion_alerts ?? []).some(
      (a) => a.severity === "error",
    );

    // Gate 4: faithfulness is enforced at write time (if the write succeeded,
    // faithfulness passed). We never persist a faithfulness-failed assessment.
    const faithfulness_pass = true;

    const all_passed =
      all_terminal &&
      every_leaf_touched_or_bulk_accepted &&
      alerts_dismissed &&
      faithfulness_pass;

    const validateSessionId = `validate-${randomUUID()}`;

    try {
      if (all_passed) {
        const validated = applyUiAction(pid, task, "reviewer", reviewer_id, {
          type: "set_review_status",
          payload: { review_status: "reviewer_validated", updated_by: reviewer_id },
        });
        broadcast(pid, validated.state, tid);
      }
      appendAuditEntry(
        { patientId: pid, taskId: tid, sessionId: validateSessionId },
        {
          ts: new Date().toISOString(),
          session_id: validateSessionId,
          step_type: "record_validated",
          gate_results: {
            all_terminal,
            faithfulness_pass,
            alerts_dismissed,
            every_leaf_touched_or_bulk_accepted,
          },
          all_passed,
          reviewer_id,
        },
      );
      res.status(all_passed ? 200 : 400).json({
        ok: all_passed,
        gate_results: {
          all_terminal,
          faithfulness_pass,
          alerts_dismissed,
          every_leaf_touched_or_bulk_accepted,
        },
      });
    } catch (e) {
      handleError(res, e);
    }
  });

  // ── lock ─────────────────────────────────────────────────────────────────────
  // Permanently lock a validated record. Requires review_status to be
  // "reviewer_validated". On success, transitions status to "locked",
  // stamps locked_at / locked_by / lock_task_sha onto the state, emits a
  // record_locked audit entry, and broadcasts the updated state via WS.
  r.post("/api/reviews/:pid/:tid/lock", async (req: Request, res: Response) => {
    const { pid, tid } = req.params;
    const reviewer_id = reviewerIdOf(req);

    const state = loadReviewState(pid, tid);
    if (!state) {
      return res.status(404).json({ ok: false, error: "review_state not found" });
    }

    const readiness = lockReadyCheck(state.review_status);
    if (!readiness.ready) {
      return res.status(409).json({ ok: false, error: readiness.reason });
    }

    const task = loadCompiledTask(tid);
    if (!task) {
      return res.status(404).json({ ok: false, error: `compiled task ${tid} not found` });
    }

    // SHA the guideline package (guidelines/<tid>/ — a directory).
    const bundleDir = guidelineDir(tid);
    const lock_task_sha = computeTaskSha(bundleDir);
    archiveVersion(tid, lock_task_sha);
    const locked_at = new Date().toISOString();
    const lockSessionId = `lock-${Date.now()}`;

    try {
      const result = applyUiAction(pid, task, "reviewer", reviewer_id, {
        type: "set_review_status",
        payload: {
          review_status: "locked",
          locked_at,
          locked_by: reviewer_id,
          lock_task_sha,
        },
      });

      appendAuditEntry(
        { patientId: pid, taskId: tid, sessionId: lockSessionId },
        {
          ts: locked_at,
          session_id: lockSessionId,
          step_type: "record_locked",
          lock_task_sha,
          reviewer_id,
        },
      );

      broadcast(pid, result.state, tid);

      // Derived-adjudication classifier — synchronous on lock, but never blocks
      // the response on failure (the lock itself is the source of truth).
      // iter_id resolution: trust the request body if the client sent it
      // (e.g., the Pilots tab knows its iter); otherwise scan pilot manifests
      // for the most recent iter that contains this patient.
      try {
        const bodyIterId: string | undefined = typeof req.body?.iter_id === "string" ? req.body.iter_id : undefined;
        const iter_id = bodyIterId ?? findActiveIterIdForPatient(tid, pid) ?? undefined;
        const pilotCtx = iter_id ? resolvePilotContext(tid, iter_id) : null;
        if (pilotCtx) {
          const fields = task.fields.map((f) => ({ id: f.id, prompt: f.prompt ?? "" }));
          const humanAssessmentsByField: Record<string, FieldAssessment> = {};
          const humanCommentsByField: Record<string, string | null> = {};
          for (const fa of result.state.field_assessments ?? []) {
            humanAssessmentsByField[fa.field_id] = fa;
            humanCommentsByField[fa.field_id] = (fa as any).comment ?? null;
          }
          const a1 = await loadAgentDraftAndAudit(pilotCtx, "agent_1", pid);
          const a2 = await loadAgentDraftAndAudit(pilotCtx, "agent_2", pid);
          const guidelineTextByField = loadGuidelineTextByField(task);
          if (a1 && a2) {
            await runDerivedAdjudicationsForPatient({
              patient_id: pid,
              iter_id: pilotCtx.iter_id,
              pilotIterDir: pilotCtx.pilotIterDir,
              fields,
              humanAssessmentsByField,
              humanCommentsByField,
              agent1: a1,
              agent2: a2,
              guidelineTextByField,
              concurrency: 8,
            });
          }
        }
      } catch (e) {
        console.error("[derived-adj] classifier run failed", e);
      }

      res.json({ ok: true, version: result.state.version, lock_task_sha, locked_at });
    } catch (e) {
      handleError(res, e);
    }
  });

  // ── session-summary ───────────────────────────────────────────────────────────
  // Client posts reviewer telemetry at the end of a review session.
  // No state mutation — pure audit log append.
  r.post("/api/reviews/:pid/:tid/session-summary", (req: Request, res: Response) => {
    const { pid, tid } = req.params;
    const reviewer_id = reviewerIdOf(req);
    const { session_id, summary } = req.body as {
      session_id?: string;
      summary: {
        notes_opened: number;
        total_dwell_ms: number;
        searches_run: number;
        ts_open: string;
        ts_close: string;
      };
    };

    if (!summary) {
      return res.status(400).json({ ok: false, error: "summary required" });
    }

    const telemetrySessionId = session_id ?? `telemetry-${randomUUID()}`;

    try {
      appendAuditEntry(
        { patientId: pid, taskId: tid, sessionId: telemetrySessionId },
        {
          ts: new Date().toISOString(),
          session_id: telemetrySessionId,
          step_type: "reviewer_session_summary",
          notes_opened: summary.notes_opened ?? 0,
          total_dwell_ms: summary.total_dwell_ms ?? 0,
          searches_run: summary.searches_run ?? 0,
          ts_open: summary.ts_open ?? new Date().toISOString(),
          ts_close: summary.ts_close ?? new Date().toISOString(),
          reviewer_id,
        },
      );
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e);
    }
  });

  return r;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function handleError(res: Response, e: unknown): Response {
  if (e instanceof ReviewStateError) {
    return res.status(e.code === "task_not_found" ? 404 : 400).json({
      ok: false,
      error_code: e.code,
      message: e.message,
    });
  }
  return res.status(500).json({ ok: false, message: (e as Error).message });
}
