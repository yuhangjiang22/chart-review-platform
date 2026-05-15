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

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readNote } from "@chart-review/patients";
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
  readUnitHistory,
} from "./lib/audit-trail.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { pathFor } from "@chart-review/storage";
import { writeJsonAtomic } from "@chart-review/fs-atomic";
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

  // NER sibling to field-history. Same audit store, filters by
  // payload_span_id (unit_kind="span") instead of payload_field_id.
  // The audit-trail readUnitHistory function handles both shapes; here
  // we call it with unitKind="span" so only span events come back.
  {
    method: "GET", pattern: "/api/reviews/:patientId/:taskId/span-history/:spanId",
    handler: async (_b, _r, p) => {
      try {
        const entries = readUnitHistory(p.patientId, p.taskId, p.spanId, "span");
        return { span_id: p.spanId, entries };
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

  // ── Cluster D — NER span mutations (Phase 1.8) ──────────────────────
  // PATCH /api/reviews/:patientId/:taskId/spans/:spanId
  //   body: { status?, concept_name?, override_reason? }
  // Reviewer-facing mutation for spans. Only applicable when the task's
  // task_kind is "ner". The MCP set_span_status tool is for agents; this
  // route is the HTTP entrypoint used by the SpanReview UI.
  {
    method: "PATCH", pattern: "/api/reviews/:patientId/:taskId/spans/:spanId",
    handler: async (body, req, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, { error: "task not found" });
      if (task.task_kind !== "ner") {
        throw httpErr(400, { error: `task ${p.taskId} is not an NER task` });
      }
      const { status, concept_name, override_reason } = (body ?? {}) as {
        status?: "mapped" | "novel_candidate" | "rejected";
        concept_name?: string;
        override_reason?: string;
      };
      if (status === undefined && concept_name === undefined) {
        throw httpErr(400, { error: "at least one of status, concept_name required" });
      }
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const state = loadOrCreateReviewState(p.patientId, task);
      const spans = state.span_labels ?? [];
      const idx = spans.findIndex((s) => s.span_id === p.spanId);
      if (idx < 0) throw httpErr(404, { error: `span_id ${p.spanId} not found` });
      const before = { ...spans[idx]! };
      if (concept_name !== undefined) spans[idx]!.concept_name = concept_name;
      // Status is derived from concept_name presence — non-empty maps to
      // "mapped", empty maps to "novel_candidate". An explicit status in
      // the body still wins so agent tools / programmatic callers can
      // override (e.g. set "rejected"), but reviewer concept-name edits
      // alone keep status in sync.
      if (status !== undefined) {
        spans[idx]!.status = status;
      } else if (concept_name !== undefined) {
        spans[idx]!.status = concept_name.trim() ? "mapped" : "novel_candidate";
      }
      if (override_reason !== undefined) spans[idx]!.override_reason = override_reason;
      state.span_labels = spans;
      state.version = (state.version ?? 0) + 1;
      state.updated_at = new Date().toISOString();
      state.updated_by = "reviewer";
      const fp = pathFor.reviewState(p.patientId, p.taskId);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      writeJsonAtomic(fp, state);
      appendAuditEntry(
        { patientId: p.patientId, taskId: p.taskId, sessionId: `reviewer__${reviewerId}` },
        {
          ts: new Date().toISOString(),
          session_id: `reviewer__${reviewerId}`,
          step_type: "ui_action",
          action_type: "patch_span",
          source: "reviewer",
          payload_summary: [
            status !== undefined ? `status=${before.status ?? "(none)"}→${status}` : null,
            concept_name !== undefined ? `concept=${before.concept_name}→${concept_name}` : null,
          ].filter(Boolean).join(" "),
          payload_span_id: p.spanId,
        },
      );
      return { ok: true, span: spans[idx], version: state.version };
    },
  },

  // DELETE /api/reviews/:patientId/:taskId/spans/:spanId — remove a span
  // entirely. The reviewer-facing "reject" affordance: the UI uses this
  // when the reviewer decides the span is not just wrong-status but
  // shouldn't exist at all (e.g. agent over-extraction). Idempotent —
  // returns 404 if the span is not present.
  {
    method: "DELETE", pattern: "/api/reviews/:patientId/:taskId/spans/:spanId",
    handler: async (_b, req, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, { error: "task not found" });
      if (task.task_kind !== "ner") {
        throw httpErr(400, { error: `task ${p.taskId} is not an NER task` });
      }
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const state = loadOrCreateReviewState(p.patientId, task);
      const spans = state.span_labels ?? [];
      const idx = spans.findIndex((s) => s.span_id === p.spanId);
      if (idx < 0) throw httpErr(404, { error: `span_id ${p.spanId} not found` });
      const removed = spans[idx]!;
      spans.splice(idx, 1);
      state.span_labels = spans;
      state.version = (state.version ?? 0) + 1;
      state.updated_at = new Date().toISOString();
      state.updated_by = "reviewer";
      const fp = pathFor.reviewState(p.patientId, p.taskId);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      writeJsonAtomic(fp, state);
      appendAuditEntry(
        { patientId: p.patientId, taskId: p.taskId, sessionId: `reviewer__${reviewerId}` },
        {
          ts: new Date().toISOString(),
          session_id: `reviewer__${reviewerId}`,
          step_type: "ui_action",
          action_type: "delete_span",
          source: "reviewer",
          payload_summary: `entity_type=${removed.entity_type} text=${JSON.stringify(removed.text).slice(0, 60)}`,
          payload_span_id: p.spanId,
        },
      );
      return { ok: true, version: state.version };
    },
  },

  // POST /api/reviews/:patientId/:taskId/spans — click-and-drag span
  // creation from SpanReview. Body shape mirrors the NerSpan minus
  // span_id (server computes a stable hash). Faithfulness-gated:
  // refuses writes where source[start:end] !== text.
  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/spans",
    handler: async (body, req, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, { error: "task not found" });
      if (task.task_kind !== "ner") {
        throw httpErr(400, { error: `task ${p.taskId} is not an NER task` });
      }
      const b = (body ?? {}) as {
        note_id?: string;
        text?: string;
        anchor?: string;
        start?: number;
        end?: number;
        entity_type?: string;
        concept_name?: string;
        status?: "mapped" | "novel_candidate" | "rejected";
      };
      if (!b.note_id || typeof b.note_id !== "string") {
        throw httpErr(400, { error: "note_id required" });
      }
      if (typeof b.text !== "string" || b.text.length === 0) {
        throw httpErr(400, { error: "text required" });
      }
      if (typeof b.start !== "number" || typeof b.end !== "number" || b.start < 0 || b.end <= b.start) {
        throw httpErr(400, { error: "valid start/end offsets required" });
      }
      if (typeof b.entity_type !== "string" || !b.entity_type) {
        throw httpErr(400, { error: "entity_type required" });
      }
      // Faithfulness check: source[start:end] must equal text.
      const noteFilename = b.note_id.endsWith(".txt") ? b.note_id : `${b.note_id}.txt`;
      let source: string;
      try {
        source = readNote(p.patientId, noteFilename);
      } catch (e) {
        throw httpErr(404, { error: `note ${b.note_id}: ${(e as Error).message}` });
      }
      if (b.end > source.length) {
        throw httpErr(400, { error: `end=${b.end} exceeds note length ${source.length}` });
      }
      const observed = source.slice(b.start, b.end);
      if (observed !== b.text) {
        throw httpErr(400, {
          error: `faithfulness_violation: source[${b.start}:${b.end}]=${JSON.stringify(observed)} != text=${JSON.stringify(b.text)}`,
        });
      }
      // Compute span_id (matches the MCP write path's hash).
      const noteId = b.note_id.replace(/\.txt$/, "");
      const hash = createHash("sha256");
      hash.update(`${noteId}|${b.start}|${b.end}|${b.entity_type}`);
      const spanId = hash.digest("hex").slice(0, 16);

      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const state = loadOrCreateReviewState(p.patientId, task);
      const spans = state.span_labels ?? [];
      const existing = spans.findIndex((s) => s.span_id === spanId);
      const prevProposers = existing >= 0 ? (spans[existing]!.proposed_by ?? []) : [];
      const nextProposers = prevProposers.includes("reviewer")
        ? prevProposers
        : [...prevProposers, "reviewer"];
      const span: import("@chart-review/platform-types").SpanLabel = {
        span_id: spanId,
        note_id: noteId,
        text: b.text,
        anchor: b.anchor ?? b.text,
        start: b.start,
        end: b.end,
        entity_type: b.entity_type,
        concept_name: b.concept_name ?? "",
        status: b.status ?? (b.concept_name ? "mapped" : "novel_candidate"),
        proposed_by: nextProposers,
      };
      if (existing >= 0) spans[existing] = span;
      else spans.push(span);
      state.span_labels = spans;
      state.version = (state.version ?? 0) + 1;
      state.updated_at = new Date().toISOString();
      state.updated_by = "reviewer";
      const fp = pathFor.reviewState(p.patientId, p.taskId);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      writeJsonAtomic(fp, state);
      appendAuditEntry(
        { patientId: p.patientId, taskId: p.taskId, sessionId: `reviewer__${reviewerId}` },
        {
          ts: new Date().toISOString(),
          session_id: `reviewer__${reviewerId}`,
          step_type: "ui_action",
          action_type: existing >= 0 ? "update_span" : "create_span",
          source: "reviewer",
          payload_summary: `entity_type=${b.entity_type} concept=${b.concept_name ?? "(novel)"} text=${JSON.stringify(b.text).slice(0, 60)}`,
          payload_span_id: spanId,
        },
      );
      return { ok: true, span, version: state.version, created: existing < 0 };
    },
  },

  // POST /api/reviews/:patientId/:taskId/notes/:noteId/validation
  //   body: { validated: boolean }
  // Note-level validation toggle for NER tasks. Maintains a
  // `validated_notes: string[]` list on the review_state — defaults to
  // empty (nothing validated). Per-note validation is the unit of
  // progress the reviewer manipulates; patient-level rollup is
  // derived (every-note-validated → patient is done).
  {
    method: "POST", pattern: "/api/reviews/:patientId/:taskId/notes/:noteId/validation",
    handler: async (body, req, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, { error: "task not found" });
      if (task.task_kind !== "ner") {
        throw httpErr(400, { error: `task ${p.taskId} is not an NER task` });
      }
      const { validated } = (body ?? {}) as { validated?: boolean };
      if (typeof validated !== "boolean") {
        throw httpErr(400, { error: "validated:boolean required" });
      }
      const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
      const state = loadOrCreateReviewState(p.patientId, task);
      if (state.review_status === "locked") {
        throw httpErr(409, { error: "patient is locked; validation cannot be changed" });
      }
      const noteId = p.noteId.replace(/\.txt$/, "");
      const set = new Set(state.validated_notes ?? []);
      if (validated) set.add(noteId); else set.delete(noteId);
      state.validated_notes = [...set].sort();
      state.version = (state.version ?? 0) + 1;
      state.updated_at = new Date().toISOString();
      state.updated_by = "reviewer";
      const fp = pathFor.reviewState(p.patientId, p.taskId);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      writeJsonAtomic(fp, state);
      appendAuditEntry(
        { patientId: p.patientId, taskId: p.taskId, sessionId: `reviewer__${reviewerId}` },
        {
          ts: new Date().toISOString(),
          session_id: `reviewer__${reviewerId}`,
          step_type: "ui_action",
          action_type: validated ? "mark_note_validated" : "mark_note_unvalidated",
          source: "reviewer",
          payload_summary: `note_id=${noteId}`,
        },
      );
      return { ok: true, validated_notes: state.validated_notes, version: state.version };
    },
  },
];
