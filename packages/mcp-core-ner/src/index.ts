// Pure handler functions for the chart_review_ner MCP server.
//
// Parallel to @chart-review/mcp-core, which exposes the 7 phenotype
// tools (set_field_assessment, find_quote_offsets, etc.). This module
// exposes the 7 NER tools — 4 read-only ontology browsers and 3
// span-write tools.
//
// Two transport adapters consume these:
//   @chart-review/mcp-server-ner-anthropic — in-process via Claude Agent SDK
//   @chart-review/mcp-server-ner-stdio     — subprocess via MCP stdio
//
// Faithfulness invariant: every span the agent commits must satisfy
// `noteText.slice(start, end) === text`. set_span_label enforces this
// at the MCP boundary and refuses writes that fail. Agents that want
// the platform to compute (start, end) authoritatively call
// locate_in_source first (the recommended path).
//
// Audit trail: every span mutation appends a `ui_action` entry to the
// session's JSONL with `payload_span_id` set so audit-trail's
// readUnitHistory can rebuild the span's history.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  loadOntology,
  listEntityTypes as ontoListEntityTypes,
  getConceptTree as ontoGetConceptTree,
  normalizeToOntology as ontoNormalize,
  locateInSource as ontoLocate,
  type Ontology,
} from "@chart-review/ontology";
import { readNote } from "@chart-review/patients";
import { writeJsonAtomic } from "@chart-review/fs-atomic";
import { pathFor } from "@chart-review/storage";
import { appendAuditEntry } from "@chart-review/audit-trail";
import type { CompiledTask } from "@chart-review/tasks";
import type { SpanLabel } from "@chart-review/platform-types";

// ── public types ─────────────────────────────────────────────────────

export type CallToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

/** Per-(patient, task) session context. Includes the ontology source
 *  path — adapters resolve it from the task's pinned ontology
 *  (meta.yaml `ontology_pin` field) or from an env override. */
export interface NerMcpSession {
  patientId: string;
  task: CompiledTask;
  sessionId: string;
  /** Absolute path to the concepts.json the agent is normalizing
   *  against. Resolved by the adapter from task metadata. */
  ontologyPath: string;
  /** Optional reviewsRoot override — same AsyncLocalStorage redirect
   *  pattern used by the phenotype MCP server. When set, span writes
   *  land under <reviewsRoot>/<patient>/<task>/review_state.json
   *  instead of the global default. */
  reviewsRoot?: string;
}

export interface NerToolHooks {
  onStateUpdate(state: NerReviewState): void;
}

const noopHooks: NerToolHooks = { onStateUpdate: () => {} };

/** Shape of the NER half of review_state.json. The same file may
 *  contain phenotype `field_assessments` if the task ever evolved
 *  from phenotype-shaped reviews — we preserve any unknown keys on
 *  read-modify-write to honor the union-schema design. */
export interface NerReviewState {
  schema_version: string;
  patient_id: string;
  task_id: string;
  task_kind: "ner";
  review_status: "draft" | "agent_complete" | "reviewer_validated" | "locked";
  version: number;
  updated_at: string;
  updated_by: "agent" | "reviewer" | "system";
  span_labels: SpanLabel[];
  ontology_pin?: string;
}

// ── ontology cache ────────────────────────────────────────────────────

function ontoFor(session: NerMcpSession): Ontology {
  // loadOntology already memoizes by (path, mtime); this is just a
  // type-clean wrapper.
  return loadOntology(session.ontologyPath);
}

// ── read-only tool wrappers ───────────────────────────────────────────

export async function listEntityTypes(
  session: NerMcpSession,
): Promise<CallToolResult> {
  const r = ontoListEntityTypes(ontoFor(session));
  return { content: [{ type: "text", text: JSON.stringify(r) }] };
}

export interface GetConceptTreeArgs { entity_type: string }
export async function getConceptTree(
  session: NerMcpSession,
  args: GetConceptTreeArgs,
): Promise<CallToolResult> {
  const r = ontoGetConceptTree(ontoFor(session), args.entity_type);
  return {
    isError: !r.found,
    content: [{ type: "text", text: JSON.stringify(r) }],
  };
}

export interface NormalizeArgs {
  entity_type: string;
  label: string;
}
export async function normalizeToOntology(
  session: NerMcpSession,
  args: NormalizeArgs,
): Promise<CallToolResult> {
  const r = ontoNormalize(ontoFor(session), args.entity_type, args.label);
  return { content: [{ type: "text", text: JSON.stringify(r) }] };
}

export interface LocateArgs {
  note_id: string;
  anchor: string;
  text: string;
}

/** Resolve authoritative (start, end) offsets for `text` inside note
 *  `note_id`, located via `anchor`. Loads the note from disk via the
 *  patients package (same path the phenotype find_quote_offsets uses).
 *  Adds `note_id` to the result so the agent can paste it straight
 *  into a set_span_label call. */
export async function locateInSource(
  session: NerMcpSession,
  args: LocateArgs,
): Promise<CallToolResult> {
  const filename = args.note_id.endsWith(".txt")
    ? args.note_id
    : `${args.note_id}.txt`;
  let source: string;
  try {
    source = readNote(session.patientId, filename);
  } catch (e) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          found: false,
          start: -1, end: -1, anchor_match_count: 0,
          message: `note ${args.note_id} not found: ${(e as Error).message}`,
        }),
      }],
    };
  }
  const r = ontoLocate(source, args.anchor, args.text);
  return {
    isError: !r.found,
    content: [{
      type: "text",
      text: JSON.stringify({ ...r, note_id: args.note_id.replace(/\.txt$/, "") }),
    }],
  };
}

// ── write tools ───────────────────────────────────────────────────────

export interface SetSpanLabelArgs {
  note_id: string;
  text: string;
  anchor: string;
  start: number;
  end: number;
  entity_type: string;
  concept_name: string;
  status?: "mapped" | "novel_candidate" | "rejected";
  override_reason?: string;
}

/** Commit one span to the review state. Faithfulness gate: validates
 *  `source[start:end] === text` against the note bytes and refuses the
 *  write if the byte comparison fails. */
export async function setSpanLabel(
  session: NerMcpSession,
  args: SetSpanLabelArgs,
  hooks: NerToolHooks = noopHooks,
): Promise<CallToolResult> {
  // Faithfulness check.
  const filename = args.note_id.endsWith(".txt") ? args.note_id : `${args.note_id}.txt`;
  let source: string;
  try {
    source = readNote(session.patientId, filename);
  } catch (e) {
    return errorResult("note_not_found", `note ${args.note_id}: ${(e as Error).message}`);
  }
  if (args.start < 0 || args.end > source.length || args.start >= args.end) {
    return errorResult(
      "bad_offsets",
      `start=${args.start} end=${args.end} are out of range for note ${args.note_id} (length=${source.length})`,
    );
  }
  const observed = source.slice(args.start, args.end);
  if (observed !== args.text) {
    return errorResult(
      "faithfulness_violation",
      `note[${args.start}:${args.end}]=${JSON.stringify(observed)} ` +
      `does not match text=${JSON.stringify(args.text)}. ` +
      `Call locate_in_source first to get authoritative offsets.`,
    );
  }

  // Ontology gate. status=mapped requires concept_name to exist in the
  // ontology under the chosen entity_type — otherwise the platform was
  // silently accepting LLM-hallucinated concept names like "Lung_Cancer"
  // when the actual ontology only has "Malignant_Neoplasm". Auto-downgrade
  // to novel_candidate (concept_name="") so the write still lands but
  // the provenance is honest. The agent / extractor can re-call with the
  // right concept_name later.
  let finalConceptName = args.concept_name;
  let finalStatus: "mapped" | "novel_candidate" | "rejected" =
    args.status ?? (args.concept_name ? "mapped" : "novel_candidate");
  if (finalStatus === "mapped" && args.concept_name) {
    try {
      const onto = loadOntology(session.ontologyPath);
      const block = onto.get(args.entity_type);
      if (block) {
        const target = args.concept_name.toLowerCase().replace(/[ _-]+/g, "_");
        // Look for a case/separator-insensitive match against id or label.
        const exists = block.concepts.some((c) => {
          const id = (c.id ?? "").toLowerCase().replace(/[ _-]+/g, "_");
          const lbl = (c.label ?? "").toLowerCase().replace(/[ _-]+/g, "_");
          return id === target || lbl === target;
        });
        if (!exists) {
          finalConceptName = "";
          finalStatus = "novel_candidate";
        }
      }
    } catch {
      // If the ontology can't load, fall through — faithfulness gate
      // is the only guarantee in that degraded mode.
    }
  }

  // Compute span_id = stable hash of (note_id|start|end|entity_type).
  const noteId = args.note_id.replace(/\.txt$/, "");
  const spanId = hashSpan(noteId, args.start, args.end, args.entity_type);
  const span: SpanLabel = {
    span_id: spanId,
    note_id: noteId,
    text: args.text,
    anchor: args.anchor,
    start: args.start,
    end: args.end,
    entity_type: args.entity_type,
    concept_name: finalConceptName,
    status: finalStatus,
    ...(args.override_reason ? { override_reason: args.override_reason } : {}),
  };

  const state = readOrInitState(session);
  // Upsert by span_id: replace if already present (later commit wins).
  const idx = state.span_labels.findIndex((s) => s.span_id === spanId);
  if (idx >= 0) state.span_labels[idx] = span;
  else state.span_labels.push(span);
  state.version += 1;
  state.updated_at = new Date().toISOString();
  state.updated_by = "agent";

  persistState(session, state);
  appendSpanAudit(session, "set_span_label", spanId, args.entity_type, args.concept_name);
  hooks.onStateUpdate(state);
  return ok({ span_id: spanId, version: state.version });
}

export interface SetSpanStatusArgs {
  span_id: string;
  status: "mapped" | "novel_candidate" | "rejected";
  override_reason?: string;
}

export async function setSpanStatus(
  session: NerMcpSession,
  args: SetSpanStatusArgs,
  hooks: NerToolHooks = noopHooks,
): Promise<CallToolResult> {
  const state = readOrInitState(session);
  const span = state.span_labels.find((s) => s.span_id === args.span_id);
  if (!span) {
    return errorResult("span_not_found", `span_id ${args.span_id} not in review state`);
  }
  span.status = args.status;
  if (args.override_reason !== undefined) span.override_reason = args.override_reason;
  state.version += 1;
  state.updated_at = new Date().toISOString();
  state.updated_by = "reviewer";

  persistState(session, state);
  appendSpanAudit(session, "set_span_status", args.span_id, span.entity_type, args.status);
  hooks.onStateUpdate(state);
  return ok({ span_id: args.span_id, status: args.status, version: state.version });
}

export async function getSpanReviewState(
  session: NerMcpSession,
): Promise<CallToolResult> {
  const state = readOrInitState(session);
  return ok({
    patient_id: state.patient_id,
    task_id: state.task_id,
    version: state.version,
    review_status: state.review_status,
    span_count: state.span_labels.length,
    span_labels: state.span_labels,
  });
}

// ── helpers ───────────────────────────────────────────────────────────

function hashSpan(noteId: string, start: number, end: number, entityType: string): string {
  const h = createHash("sha256");
  h.update(`${noteId}|${start}|${end}|${entityType}`);
  return h.digest("hex").slice(0, 16);
}

function statePath(session: NerMcpSession): string {
  // With a scratch reviewsRoot (the per-run agent root passed during batch
  // runs), spans land in scratch and are promoted to the committed,
  // session-scoped path later by the run-import. Without one (e.g. the
  // standalone NER stdio server), write directly to the committed path —
  // scoped to the session so it never bleeds across sessions.
  const base = session.reviewsRoot
    ? path.join(session.reviewsRoot, session.patientId, session.task.task_id, "review_state.json")
    : pathFor.reviewState(session.sessionId, session.patientId, session.task.task_id);
  return base;
}

function readOrInitState(session: NerMcpSession): NerReviewState {
  const fp = statePath(session);
  if (fs.existsSync(fp)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, "utf8")) as Partial<NerReviewState>;
      // Union shape: file may exist with phenotype field_assessments and no
      // span_labels yet — accept that and start span_labels=[].
      return {
        schema_version: parsed.schema_version ?? "1",
        patient_id: session.patientId,
        task_id: session.task.task_id,
        task_kind: "ner",
        review_status: (parsed.review_status as NerReviewState["review_status"]) ?? "draft",
        version: typeof parsed.version === "number" ? parsed.version : 0,
        updated_at: parsed.updated_at ?? new Date().toISOString(),
        updated_by: (parsed.updated_by as NerReviewState["updated_by"]) ?? "system",
        span_labels: Array.isArray(parsed.span_labels) ? parsed.span_labels as SpanLabel[] : [],
        ...(parsed.ontology_pin ? { ontology_pin: parsed.ontology_pin } : {}),
      };
    } catch {
      /* fall through to fresh state on parse failure */
    }
  }
  return {
    schema_version: "1",
    patient_id: session.patientId,
    task_id: session.task.task_id,
    task_kind: "ner",
    review_status: "draft",
    version: 0,
    updated_at: new Date().toISOString(),
    updated_by: "system",
    span_labels: [],
  };
}

function persistState(session: NerMcpSession, state: NerReviewState): void {
  const fp = statePath(session);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  // Merge with any pre-existing phenotype fields on disk so we don't
  // clobber field_assessments written by a sibling phenotype profile
  // (rare today, but matters for the union-schema invariant).
  let merged: Record<string, unknown> = { ...(state as unknown as Record<string, unknown>) };
  if (fs.existsSync(fp)) {
    try {
      const existing = JSON.parse(fs.readFileSync(fp, "utf8")) as Record<string, unknown>;
      merged = { ...existing, ...merged };
    } catch { /* ignore parse failure; we're about to overwrite */ }
  }
  writeJsonAtomic(fp, merged);
}

function appendSpanAudit(
  session: NerMcpSession,
  actionType: string,
  spanId: string,
  entityType: string,
  payloadAnswer: string,
): void {
  appendAuditEntry(
    {
      patientId: session.patientId,
      taskId: session.task.task_id,
      sessionId: session.sessionId,
    },
    {
      ts: new Date().toISOString(),
      session_id: session.sessionId,
      step_type: "ui_action",
      action_type: actionType,
      source: "agent",
      payload_summary: `entity_type=${entityType} concept=${payloadAnswer}`,
      payload_span_id: spanId,
    },
  );
}

function ok(body: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...body }) }] };
}

function errorResult(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({ ok: false, error_code: code, message }),
    }],
  };
}
