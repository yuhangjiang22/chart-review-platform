// M6.7b — Review routes ported from v1's review-routes.ts.
//
// Per-(patient × task) review-state CRUD. This is the heart of the
// reviewer UI — every "set this answer", "add this evidence", "approve
// this draft" eventually lands here.
//
// Cluster A — read + copilot helpers (#54, #57):
//   GET    /api/reviews/:patientId/:taskId
//   POST   /api/reviews/:patientId/:taskId/suggest-override-reason
//   POST   /api/reviews/:patientId/:taskId/suggest-override-reason/stream (SSE)
//   POST   /api/reviews/:patientId/:taskId/prelock-summary
//   POST   /api/reviews/:patientId/:taskId/prelock-summary/stream (SSE)
//
// Cluster B — reviewer-side mutations + audit:
//   DELETE /api/reviews/:patientId/:taskId
//   POST   /api/reviews/:patientId/:taskId/summary
//   POST   /api/reviews/:patientId/:taskId/evidence
//   DELETE /api/reviews/:patientId/:taskId/evidence/:evidenceId
//   POST   /api/reviews/:patientId/:taskId/encounters
//   DELETE /api/reviews/:patientId/:taskId/encounters/:encounterId
//   POST   /api/reviews/:patientId/:taskId/uiactions
//   GET    /api/reviews/:patientId/:taskId/audit
//   GET    /api/reviews/:patientId/:taskId/field-history/:fieldId
//   GET    /api/reviews/:patientId/:taskId/audit/:sessionId
//   POST   /api/reviews/:patientId/:taskId/actions
//
// Cluster C — quote-offset lookup for the reviewer cite UI:
//   POST   /api/reviews/:patientId/find-quote-offsets
//
// applyReviewerAction threads applyUiAction → audit log → WS broadcast.
// The WS broadcaster is a no-op until M6.7c ports /ws/* — reviewers
// still see their own changes (REST returns the new state) but other
// connected clients don't get a push.

import type { RouteEntry } from "./router.js";
import type { SSEStream } from "./core-routes.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import {
  applyUiAction, loadOrCreate as loadOrCreateReviewState,
  resetReviewState, ReviewStateError,
  type ReviewState, type UiAction,
} from "./lib/domain/review/index.js";
import {
  appendAuditEntry, listAuditSessions, readAuditEntries, readFieldHistory,
} from "./lib/audit-trail.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { getMaturity } from "./lib/maturity.js";
import {
  suggestOverrideReason, suggestOverrideReasonStream,
} from "./lib/override-suggester.js";
import {
  preLockSummary, preLockSummaryStream,
} from "./lib/prelock-summarizer.js";
import {
  findQuoteOffsetsImpl,
} from "./lib/find-quote-offsets-impl.js";

function httpErr(status: number, payload: unknown, message?: string): Error & { status: number; payload?: unknown } {
  const err = new Error(message ?? (typeof payload === "object" && payload && "message" in payload
    ? String((payload as { message?: unknown }).message ?? "error")
    : "error")) as Error & { status: number; payload?: unknown };
  err.status = status;
  err.payload = payload;
  return err;
}

/** Translate a ReviewStateError into an HTTP error. */
function reviewStateErr(e: unknown): never {
  if (e instanceof ReviewStateError) {
    throw httpErr(
      e.code === "task_not_found" ? 404 : 400,
      { ok: false, error_code: e.code, message: e.message },
      e.message,
    );
  }
  throw httpErr(400, { ok: false, message: (e as Error).message }, (e as Error).message);
}

// WS broadcaster wired in M7.3.
import { broadcastReviewStateUpdate } from "./ws.js";

/** Shared mutate pipeline. Mirrors v1's applyReviewerAction (audit +
 *  broadcast). The reviewer session id is patient-stable but
 *  per-reviewer ("reviewer__<reviewerId>") so the audit pane can
 *  group by who did them. */
function applyReviewerAction(
  patientId: string, taskId: string, reviewerId: string,
  action: UiAction, payloadSummary: string,
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

export const reviewRoutes: RouteEntry[] = [
  // ── Cluster A — read + copilot helpers ──────────────────────────────
  {
    method: "GET", pattern: "/api/reviews/:patientId/:taskId",
    handler: async (_b, req, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, { error: "task not found" });
      try {
        const state = loadOrCreateReviewState(p.patientId, task);
        const reviewerId = readReviewerFromRequest(req);
        const maturity = getMaturity(p.taskId);
        if (
          maturity.calibration_blinded
          && !isMethodologist(reviewerId)
          && reviewerId !== "anonymous-reviewer"
        ) {
          return {
            ...state,
            field_assessments: state.field_assessments.filter(
              (f) => f.source === "agent" || f.updated_by === reviewerId,
            ),
          };
        }
        return state;
      } catch (e) {
        throw httpErr(400, { error: (e as Error).message }, (e as Error).message);
      }
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/suggest-override-reason",
    handler: async (body, _r, p) => {
      const { field_id, old_answer, new_answer } = (body ?? {}) as {
        field_id?: string; old_answer?: unknown; new_answer?: unknown;
      };
      if (typeof field_id !== "string" || field_id.length === 0) {
        throw httpErr(400, { error: "field_id required" });
      }
      try {
        return await suggestOverrideReason({
          patientId: p.patientId, taskId: p.taskId,
          fieldId: field_id, oldAnswer: old_answer, newAnswer: new_answer,
        });
      } catch (e) {
        throw httpErr(500, { ok: false, error: String(e) });
      }
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/suggest-override-reason/stream",
    handler: async (body, _r, p) => {
      const { field_id, old_answer, new_answer } = (body ?? {}) as {
        field_id?: string; old_answer?: unknown; new_answer?: unknown;
      };
      if (typeof field_id !== "string" || field_id.length === 0) {
        throw httpErr(400, { error: "field_id required" });
      }
      const generator = suggestOverrideReasonStream({
        patientId: p.patientId, taskId: p.taskId,
        fieldId: field_id, oldAnswer: old_answer, newAnswer: new_answer,
      });
      const sse: SSEStream = {
        __sse: true,
        generator: generator as AsyncGenerator<unknown, void, void>,
      };
      return sse;
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/prelock-summary",
    handler: async (_b, _r, p) => {
      try { return await preLockSummary({ patientId: p.patientId, taskId: p.taskId }); }
      catch (e) { throw httpErr(500, { ok: false, error: String(e) }); }
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/prelock-summary/stream",
    handler: async (_b, _r, p) => {
      const generator = preLockSummaryStream({ patientId: p.patientId, taskId: p.taskId });
      const sse: SSEStream = {
        __sse: true,
        generator: generator as AsyncGenerator<unknown, void, void>,
      };
      return sse;
    },
  },

  // ── Cluster B — reviewer-side mutations + audit ─────────────────────
  {
    method: "DELETE", pattern: "/api/reviews/:patientId/:taskId",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, { error: "task not found" });
      try {
        const state = resetReviewState(p.patientId, task);
        broadcastReviewStateUpdate(p.patientId, state, p.taskId);
        return { ok: true, state };
      } catch (e) {
        throw httpErr(400, { ok: false, message: (e as Error).message });
      }
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/summary",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      try {
        return applyReviewerAction(
          p.patientId, p.taskId, reviewerId,
          { type: "set_summary", payload: body ?? {} },
          `keys=${Object.keys(body ?? {}).join(",")}`,
        );
      } catch (e) { reviewStateErr(e); }
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/evidence",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      try {
        const result = applyReviewerAction(
          p.patientId, p.taskId, reviewerId,
          { type: "select_evidence", payload: (body ?? {}) as never },
          `category=${(body as { category?: string })?.category ?? "(none)"}`,
        );
        return { ...result, evidence_id: result.added_evidence_id };
      } catch (e) { reviewStateErr(e); }
    },
  },

  {
    method: "DELETE", pattern: "/api/reviews/:patientId/:taskId/evidence/:evidenceId",
    handler: async (_b, req, p) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      try {
        return applyReviewerAction(
          p.patientId, p.taskId, reviewerId,
          { type: "clear_selected_evidence", payload: { evidence_id: p.evidenceId } },
          `evidence_id=${p.evidenceId}`,
        );
      } catch (e) { reviewStateErr(e); }
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/encounters",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const b = (body ?? {}) as {
        kind?: "encounter" | "episode"; date?: string;
        label?: string; note_ids?: string[];
      };
      if (b.kind !== "encounter" && b.kind !== "episode") {
        throw httpErr(400, { ok: false, message: 'body.kind must be "encounter" or "episode"' });
      }
      try {
        const result = applyReviewerAction(
          p.patientId, p.taskId, reviewerId,
          { type: "add_encounter", payload: { kind: b.kind, date: b.date, label: b.label, note_ids: b.note_ids } },
          `kind=${b.kind} label=${b.label ?? "(none)"}`,
        );
        return { ...result, encounter_id: result.added_encounter_id };
      } catch (e) { reviewStateErr(e); }
    },
  },

  {
    method: "DELETE", pattern: "/api/reviews/:patientId/:taskId/encounters/:encounterId",
    handler: async (_b, req, p) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      try {
        return applyReviewerAction(
          p.patientId, p.taskId, reviewerId,
          { type: "remove_encounter", payload: { encounter_id: p.encounterId } },
          `encounter_id=${p.encounterId}`,
        );
      } catch (e) { reviewStateErr(e); }
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/uiactions",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const action = body as UiAction | undefined;
      if (!action || !action.type || !("payload" in action)) {
        throw httpErr(400, { ok: false, message: "body must be {type, payload}" });
      }
      try {
        return applyReviewerAction(
          p.patientId, p.taskId, reviewerId, action, "(generic ui_action)",
        );
      } catch (e) { reviewStateErr(e); }
    },
  },

  {
    method: "GET", pattern: "/api/reviews/:patientId/:taskId/audit",
    handler: async (_b, _r, p) => {
      try { return listAuditSessions(p.patientId, p.taskId); }
      catch (e) { throw httpErr(400, { error: (e as Error).message }); }
    },
  },

  {
    method: "GET", pattern: "/api/reviews/:patientId/:taskId/field-history/:fieldId",
    handler: async (_b, _r, p) => {
      try {
        const entries = readFieldHistory(p.patientId, p.taskId, p.fieldId);
        return { field_id: p.fieldId, entries };
      } catch (e) {
        throw httpErr(400, { error: (e as Error).message });
      }
    },
  },

  {
    method: "GET", pattern: "/api/reviews/:patientId/:taskId/audit/:sessionId",
    handler: async (_b, _r, p) => {
      try {
        const entries = readAuditEntries({
          patientId: p.patientId, taskId: p.taskId, sessionId: p.sessionId,
        });
        return { session_id: p.sessionId, entries };
      } catch (e) {
        throw httpErr(400, { error: (e as Error).message });
      }
    },
  },

  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/actions",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      try {
        return applyReviewerAction(
          p.patientId, p.taskId, reviewerId,
          { type: "set_field_assessment", payload: body as never },
          `field_id=${(body as { field_id?: string })?.field_id ?? "(none)"}`,
        );
      } catch (e) { reviewStateErr(e); }
    },
  },

  // ── Cluster C — quote-offset lookup ─────────────────────────────────
  // Always returns 200 on a well-formed body; surfaces ok/error_code in
  // the JSON payload itself.
  {
    method: "POST", pattern: "/api/reviews/:patientId/find-quote-offsets",
    handler: async (body, _r, p) => {
      const { note_id, snippet } = (body ?? {}) as {
        note_id?: unknown; snippet?: unknown;
      };
      if (typeof note_id !== "string" || typeof snippet !== "string") {
        throw httpErr(400, { error: "note_id and snippet must be strings" });
      }
      return findQuoteOffsetsImpl(p.patientId, note_id, snippet);
    },
  },
];
