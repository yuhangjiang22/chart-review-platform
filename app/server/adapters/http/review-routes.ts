/**
 * adapters/http/review-routes — HTTP adapter for the per-(patient × task)
 * review-state surface that bypasses the reviewerRouter named endpoints.
 *
 * Two clusters live here:
 *
 * Cluster A — read + copilot helpers (#54, #57):
 *   GET    /api/reviews/:patientId/:taskId
 *   POST   /api/reviews/:patientId/:taskId/suggest-override-reason
 *   POST   /api/reviews/:patientId/:taskId/suggest-override-reason/stream
 *   POST   /api/reviews/:patientId/:taskId/prelock-summary
 *   POST   /api/reviews/:patientId/:taskId/prelock-summary/stream
 *
 * Cluster B — reviewer-side mutations + audit:
 *   DELETE /api/reviews/:patientId/:taskId
 *   POST   /api/reviews/:patientId/:taskId/summary
 *   POST   /api/reviews/:patientId/:taskId/evidence
 *   DELETE /api/reviews/:patientId/:taskId/evidence/:evidenceId
 *   POST   /api/reviews/:patientId/:taskId/encounters
 *   DELETE /api/reviews/:patientId/:taskId/encounters/:encounterId
 *   POST   /api/reviews/:patientId/:taskId/uiactions
 *   GET    /api/reviews/:patientId/:taskId/audit
 *   GET    /api/reviews/:patientId/:taskId/field-history/:fieldId
 *   GET    /api/reviews/:patientId/:taskId/audit/:sessionId
 *   POST   /api/reviews/:patientId/:taskId/actions
 *
 * Cluster C — quote-offset lookup for the reviewer cite UI:
 *   POST   /api/reviews/:patientId/find-quote-offsets
 *
 * The named reviewer endpoints (accept-draft, bulk-accept, blind-submit,
 * validate, lock, session-summary) live in routes-reviewer.ts and are
 * NOT touched here.
 *
 * Mutating routes go through `applyReviewerAction`, which threads
 * applyUiAction → audit log → WS broadcast. The broadcaster is injected
 * by the caller (server.ts) so this module stays free of WebSocket
 * references — same pattern as runRouter / pilotRouter / reviewerRouter.
 */

import express, { Router, type Response, type Request } from "express";
import {
  applyUiAction,
  loadOrCreate as loadOrCreateReviewState,
  resetReviewState,
  ReviewStateError,
  type ReviewState,
  type UiAction,
} from "../../domain/review/index.js";
import {
  appendAuditEntry,
  listAuditSessions,
  readAuditEntries,
  readFieldHistory,
} from "../../audit-trail.js";
import { loadCompiledTask } from "../../tasks.js";
import { reviewerIdOf, isMethodologist } from "../../auth.js";
import { getMaturity } from "../../maturity.js";
import {
  suggestOverrideReason,
  suggestOverrideReasonStream,
} from "../../override-suggester.js";
import {
  preLockSummary,
  preLockSummaryStream,
} from "../../prelock-summarizer.js";
import { findQuoteOffsetsImpl } from "../../find-quote-offsets-impl.js";

export interface ReviewRouterOptions {
  /**
   * Push a review_state_update event to every WS client subscribed to the
   * given (patientId, taskId). Called from every mutating endpoint so the
   * UI sees changes the reviewer made via REST.
   */
  broadcastReviewStateUpdate: (
    patientId: string,
    state: ReviewState,
    taskId?: string,
  ) => void;
}

export function reviewRouter(opts: ReviewRouterOptions): Router {
  const router = Router();
  const { broadcastReviewStateUpdate } = opts;

  /**
   * applyReviewerAction — shared mutate pipeline for every reviewer-side
   * REST endpoint in Cluster B.
   *
   * The reviewer doesn't have a session_id like the chat agent; we use
   * the patient_id+task_id+timestamp as a stable correlation token in
   * the audit JSONL.
   */
  function applyReviewerAction(
    patientId: string,
    taskId: string,
    reviewerId: string,
    action: UiAction,
    payloadSummary: string,
  ): {
    ok: true;
    state: ReviewState;
    warnings: string[];
    added_evidence_id?: string;
    added_encounter_id?: string;
  } {
    const task = loadCompiledTask(taskId);
    if (!task) throw new ReviewStateError("task_not_found", `task ${taskId} not found`);
    const result = applyUiAction(patientId, task, "reviewer", reviewerId, action);
    // Reviewer-source ui_action entries land in a per-reviewer session
    // JSONL alongside the agent's chat sessions, so the audit pane sees
    // both. The session id encodes the reviewer so a future viewer can
    // group actions by who did them.
    const reviewerSession = `reviewer__${reviewerId}`;
    appendAuditEntry(
      { patientId, taskId, sessionId: reviewerSession },
      {
        ts: new Date().toISOString(),
        session_id: reviewerSession,
        step_type: "ui_action",
        action_type: action.type,
        source: "reviewer",
        payload_summary: payloadSummary,
        result_version: result.state.version,
        added_evidence_id: result.added_evidence_id,
        ...(action.type === "set_field_assessment" && {
          payload_field_id: (action.payload as { field_id?: string }).field_id,
          payload_answer: (action.payload as { answer?: unknown }).answer,
        }),
      },
    );
    broadcastReviewStateUpdate(patientId, result.state, taskId);
    return { ok: true, ...result };
  }

  function handleReviewerError(res: Response, e: unknown) {
    if (e instanceof ReviewStateError) {
      return res
        .status(e.code === "task_not_found" ? 404 : 400)
        .json({ ok: false, error_code: e.code, message: e.message });
    }
    res.status(400).json({ ok: false, message: (e as Error).message });
  }

  // ── Cluster A — read + copilot helpers ──────────────────────────────────────

  // Review-state endpoints (per-patient × per-task). When the guideline is
  // calibration_blinded, non-methodologist reviewers see only agent-source
  // assessments + their own — so two reviewers calibrating on the same
  // patient don't cross-contaminate (#29).
  router.get("/api/reviews/:patientId/:taskId", (req, res) => {
    const task = loadCompiledTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: "task not found" });
    try {
      const state = loadOrCreateReviewState(req.params.patientId, task);
      const reviewerId = reviewerIdOf(req);
      const maturity = getMaturity(req.params.taskId);
      if (
        maturity.calibration_blinded &&
        !isMethodologist(reviewerId) &&
        reviewerId !== "anonymous-reviewer"
      ) {
        const filtered = {
          ...state,
          field_assessments: state.field_assessments.filter(
            (f) => f.source === "agent" || f.updated_by === reviewerId,
          ),
        };
        return res.json(filtered);
      }
      res.json(state);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // #54 — one-shot chart-review-copilot Mode 4 (Document) suggestion. The reviewer's
  // OverrideForm posts the proposed new answer here and gets back a suggested
  // override-reason paragraph that it inlines into the rationale textarea.
  // Nothing is committed; the reviewer always edits and submits via the
  // existing /actions endpoint.
  router.post(
    "/api/reviews/:patientId/:taskId/suggest-override-reason",
    express.json(),
    async (req, res) => {
      const { patientId, taskId } = req.params as {
        patientId: string;
        taskId: string;
      };
      const { field_id, old_answer, new_answer } = req.body ?? {};
      if (typeof field_id !== "string" || field_id.length === 0) {
        return res.status(400).json({ error: "field_id required" });
      }
      try {
        const out = await suggestOverrideReason({
          patientId,
          taskId,
          fieldId: field_id,
          oldAnswer: old_answer,
          newAnswer: new_answer,
        });
        res.json(out);
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    },
  );

  // SSE variant of #54 — streams tool_use / narration / result events as the
  // chart-review-copilot makes its way to the final paragraph. The UI renders tool
  // pills live so the 30 s wait isn't silent.
  router.post(
    "/api/reviews/:patientId/:taskId/suggest-override-reason/stream",
    express.json(),
    async (req, res) => {
      const { patientId, taskId } = req.params as {
        patientId: string;
        taskId: string;
      };
      const { field_id, old_answer, new_answer } = req.body ?? {};
      if (typeof field_id !== "string" || field_id.length === 0) {
        return res.status(400).json({ error: "field_id required" });
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      try {
        for await (const ev of suggestOverrideReasonStream({
          patientId,
          taskId,
          fieldId: field_id,
          oldAnswer: old_answer,
          newAnswer: new_answer,
        })) {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      } catch (e) {
        res.write(`data: ${JSON.stringify({ type: "error", error: String(e) })}\n\n`);
      } finally {
        res.end();
      }
    },
  );

  // SSE variant of #57 — same idea: tool pills land live while the copilot
  // reads review_state + criterion files for each field.
  router.post(
    "/api/reviews/:patientId/:taskId/prelock-summary/stream",
    express.json(),
    async (req, res) => {
      const { patientId, taskId } = req.params as {
        patientId: string;
        taskId: string;
      };
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      try {
        for await (const ev of preLockSummaryStream({ patientId, taskId })) {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      } catch (e) {
        res.write(`data: ${JSON.stringify({ type: "error", error: String(e) })}\n\n`);
      } finally {
        res.end();
      }
    },
  );

  // #57 — pre-lock copilot summary. The reviewer hits this before clicking Lock
  // to get a checklist of what was approved/overridden + anything that would
  // block or weaken the lock. Read-only.
  router.post(
    "/api/reviews/:patientId/:taskId/prelock-summary",
    express.json(),
    async (req, res) => {
      const { patientId, taskId } = req.params as {
        patientId: string;
        taskId: string;
      };
      try {
        const out = await preLockSummary({ patientId, taskId });
        res.json(out);
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    },
  );

  // ── Cluster B — reviewer-side mutations + audit ─────────────────────────────

  // Reset the review state to an empty draft. Preserves chat/ audit logs.
  router.delete("/api/reviews/:patientId/:taskId", (req, res) => {
    const task = loadCompiledTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: "task not found" });
    try {
      const state = resetReviewState(req.params.patientId, task);
      broadcastReviewStateUpdate(req.params.patientId, state, req.params.taskId);
      res.json({ ok: true, state });
    } catch (e) {
      res.status(400).json({ ok: false, message: (e as Error).message });
    }
  });

  // Reviewer-side summary update (sugar around POST /actions).
  router.post("/api/reviews/:patientId/:taskId/summary", (req, res) => {
    try {
      const result = applyReviewerAction(
        req.params.patientId,
        req.params.taskId,
        reviewerIdOf(req),
        { type: "set_summary", payload: req.body ?? {} },
        `keys=${Object.keys(req.body ?? {}).join(",")}`,
      );
      res.json(result);
    } catch (e) {
      handleReviewerError(res, e);
    }
  });

  // Reviewer-side select_evidence (sugar around POST /actions).
  router.post("/api/reviews/:patientId/:taskId/evidence", (req, res) => {
    try {
      const result = applyReviewerAction(
        req.params.patientId,
        req.params.taskId,
        reviewerIdOf(req),
        { type: "select_evidence", payload: req.body ?? {} },
        `category=${req.body?.category ?? "(none)"}`,
      );
      res.json({ ...result, evidence_id: result.added_evidence_id });
    } catch (e) {
      handleReviewerError(res, e);
    }
  });

  router.delete(
    "/api/reviews/:patientId/:taskId/evidence/:evidenceId",
    (req, res) => {
      try {
        const result = applyReviewerAction(
          req.params.patientId,
          req.params.taskId,
          reviewerIdOf(req),
          {
            type: "clear_selected_evidence",
            payload: { evidence_id: req.params.evidenceId },
          },
          `evidence_id=${req.params.evidenceId}`,
        );
        res.json(result);
      } catch (e) {
        handleReviewerError(res, e);
      }
    },
  );

  // #45 — encounter / episode CRUD. The schema has lived in review_state for
  // a while; these routes give the reviewer a way to actually create + remove
  // encounters from the UI. Both go through the standard applyReviewerAction
  // pipeline (audit + WS broadcast).
  router.post("/api/reviews/:patientId/:taskId/encounters", (req, res) => {
    const body = (req.body ?? {}) as {
      kind?: "encounter" | "episode";
      date?: string;
      label?: string;
      note_ids?: string[];
    };
    if (body.kind !== "encounter" && body.kind !== "episode") {
      return res.status(400).json({
        ok: false,
        message: 'body.kind must be "encounter" or "episode"',
      });
    }
    try {
      const result = applyReviewerAction(
        req.params.patientId,
        req.params.taskId,
        reviewerIdOf(req),
        {
          type: "add_encounter",
          payload: {
            kind: body.kind,
            date: body.date,
            label: body.label,
            note_ids: body.note_ids,
          },
        },
        `kind=${body.kind} label=${body.label ?? "(none)"}`,
      );
      res.json({ ...result, encounter_id: result.added_encounter_id });
    } catch (e) {
      handleReviewerError(res, e);
    }
  });

  router.delete(
    "/api/reviews/:patientId/:taskId/encounters/:encounterId",
    (req, res) => {
      try {
        const result = applyReviewerAction(
          req.params.patientId,
          req.params.taskId,
          reviewerIdOf(req),
          {
            type: "remove_encounter",
            payload: { encounter_id: req.params.encounterId },
          },
          `encounter_id=${req.params.encounterId}`,
        );
        res.json(result);
      } catch (e) {
        handleReviewerError(res, e);
      }
    },
  );

  // Generic actions endpoint — accepts any UiAction. The /summary,
  // /actions, /evidence sugar endpoints above are now thin wrappers
  // around this same path. Useful when a future client wants to apply
  // a batch of typed actions without learning N specific URLs.
  router.post("/api/reviews/:patientId/:taskId/uiactions", (req, res) => {
    const action = req.body as UiAction | undefined;
    if (!action || !action.type || !("payload" in action)) {
      return res.status(400).json({
        ok: false,
        message: "body must be {type, payload}",
      });
    }
    try {
      const result = applyReviewerAction(
        req.params.patientId,
        req.params.taskId,
        reviewerIdOf(req),
        action,
        `(generic ui_action)`,
      );
      res.json(result);
    } catch (e) {
      handleReviewerError(res, e);
    }
  });

  // Audit-trail discovery — list every chat session JSONL for this
  // patient×task. Most recent first.
  router.get("/api/reviews/:patientId/:taskId/audit", (req, res) => {
    try {
      res.json(listAuditSessions(req.params.patientId, req.params.taskId));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // #43 — per-field adjudication trail. Filters across every chat session
  // for this patient×task to entries that touched the given field. Used by
  // CriterionPane to show "history" without forcing the reviewer into the
  // full audit viewer.
  router.get(
    "/api/reviews/:patientId/:taskId/field-history/:fieldId",
    (req, res) => {
      try {
        const entries = readFieldHistory(
          req.params.patientId,
          req.params.taskId,
          req.params.fieldId,
        );
        res.json({ field_id: req.params.fieldId, entries });
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    },
  );

  // Audit-trail viewer — returns one session's JSONL as a JSON array.
  router.get("/api/reviews/:patientId/:taskId/audit/:sessionId", (req, res) => {
    try {
      const entries = readAuditEntries({
        patientId: req.params.patientId,
        taskId: req.params.taskId,
        sessionId: req.params.sessionId,
      });
      res.json({ session_id: req.params.sessionId, entries });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Reviewer applies a field assessment (sugar around POST /uiactions).
  // Body shape: SetAssessmentInput (field_id, answer, evidence, …).
  // The /uiactions endpoint accepts any UiAction; this one wraps the
  // payload in {type: "set_field_assessment"} for legacy clients.
  router.post("/api/reviews/:patientId/:taskId/actions", (req, res) => {
    try {
      const result = applyReviewerAction(
        req.params.patientId,
        req.params.taskId,
        reviewerIdOf(req),
        { type: "set_field_assessment", payload: req.body },
        `field_id=${req.body?.field_id ?? "(none)"}`,
      );
      res.json(result);
    } catch (e) {
      handleReviewerError(res, e);
    }
  });

  // Quote-offset lookup for the reviewer cite UI. Mirrors the MCP
  // find_quote_offsets tool (#xx) so the UI can resolve a verbatim snippet
  // to character offsets without going through chat. No taskId required —
  // notes are per-patient. Always responds 200 on a well-formed body and
  // surfaces success / error_code in the JSON payload itself, so the
  // client can render either path uniformly.
  router.post(
    "/api/reviews/:patientId/find-quote-offsets",
    (req: Request, res: Response) => {
      const { patientId } = req.params;
      const { note_id, snippet } = (req.body ?? {}) as {
        note_id?: unknown;
        snippet?: unknown;
      };
      if (typeof note_id !== "string" || typeof snippet !== "string") {
        return res.status(400).json({
          error: "note_id and snippet must be strings",
        });
      }
      const result = findQuoteOffsetsImpl(patientId, note_id, snippet);
      return res.status(200).json(result);
    },
  );

  return router;
}

import { findDerivedAdjudicationsForPatient } from "../../derived-adjudications/store.js";
import { pilotIterDir as computePilotIterDir } from "../../domain/iter/pilots.js";

export interface DerivedAdjudicationRouteDeps {
  resolvePilotIterDir: (iter_id: string) => string | null;
  /** Optional. When set, the client-friendly endpoint
   *  GET /api/reviews/:patientId/:taskId/derived-adjudications resolves
   *  iter_id from (taskId, patientId) so the client doesn't have to know it. */
  findActiveIterIdForPatient?: (taskId: string, patientId: string) => string | null;
}

export function mountDerivedAdjudicationRoutes(
  app: express.Express,
  deps: DerivedAdjudicationRouteDeps,
): void {
  // Iter-id-in-path: used by callers that already know the iter (e.g. Pilots tab).
  app.get(
    "/api/pilots/:iterId/derived-adjudications/:patientId",
    (req: Request, res: Response) => {
      const { iterId, patientId } = req.params;
      const dir = deps.resolvePilotIterDir(iterId);
      if (!dir) {
        return res.status(404).json({ ok: false, error: "iter not found" });
      }
      const records = findDerivedAdjudicationsForPatient(dir, patientId);
      res.json({ ok: true, records });
    },
  );

  // Client-friendly: resolves iter_id from (taskId, patientId) server-side.
  // Returns { ok: true, records: [], iter_id: null } when the patient is not
  // in any pilot iter — never 404s, so the client renders cleanly.
  if (deps.findActiveIterIdForPatient) {
    const findIter = deps.findActiveIterIdForPatient;
    app.get(
      "/api/reviews/:patientId/:taskId/derived-adjudications",
      (req: Request, res: Response) => {
        const { patientId, taskId } = req.params;
        const iter_id = findIter(taskId, patientId);
        if (!iter_id) {
          return res.json({ ok: true, records: [], iter_id: null });
        }
        const dir = computePilotIterDir(taskId, iter_id);
        const records = findDerivedAdjudicationsForPatient(dir, patientId);
        res.json({ ok: true, records, iter_id });
      },
    );
  }
}
