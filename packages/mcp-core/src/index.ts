// mcp-handlers.ts — pure handler functions for the chart_review_state
// MCP server, decoupled from any specific MCP transport SDK.
//
// `mcp-tools.ts` adapts these to Anthropic's in-process
// @anthropic-ai/claude-agent-sdk via `tool()` + `createSdkMcpServer()`.
// `mcp-server/index.ts` adapts them to a stdio MCP server via
// @modelcontextprotocol/sdk for non-Anthropic providers (Codex, etc.).
//
// The handler signatures are stable across both adapters: each takes
// an explicit `McpSession` (patientId + task + sessionId) plus typed
// args, and returns a `CallToolResult` shaped to match the MCP wire
// protocol. Adapters only translate transport-specific message shapes.

import { z } from "zod";
import { findQuoteOffsetsImpl } from "@chart-review/find-quote-offsets";
import type { CompiledTask } from "@chart-review/tasks";
import {
  listNotes as listNotesFn,
  readNote as readNoteFn,
  readStructured as readStructuredFn,
} from "@chart-review/patients";
import { phenotypeSkillDir } from "@chart-review/rubric";
import fs from "node:fs";
import path from "node:path";
import {
  applyUiAction,
  load as loadReviewState,
  loadOrCreate,
  type ReviewState,
  type UiAction,
} from "@chart-review/domain-review";
import { appendAuditEntry } from "@chart-review/audit-trail";
import { fieldApplicability, gateReferencedIds } from "@chart-review/contract-eval";

// ── public types ─────────────────────────────────────────────────────

/** CallToolResult shape mirrored from the MCP spec. The Anthropic SDK
 *  doesn't re-export this; we define it here so both adapters can
 *  return the same value. */
export type CallToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

/** Per-(patient, task) session context. Adapters construct one of
 *  these from their transport-specific session info — env vars for
 *  the subprocess server, closure-captured args for the in-process
 *  Anthropic adapter. */
export interface McpSession {
  patientId: string;
  task: CompiledTask;
  sessionId: string;
}

/** Optional hook fired after every successful state mutation. The
 *  in-process Anthropic adapter wires this to the WebSocket
 *  broadcaster; the subprocess server passes a no-op (the main
 *  server discovers state changes by polling disk). */
export interface ReviewToolHooks {
  onStateUpdate(state: ReviewState): void;
}

const noopHooks: ReviewToolHooks = { onStateUpdate: () => {} };

// ── shared zod schema (re-exported for adapters) ─────────────────────

/** Flat evidence schema. Avoids z.union (Together-routed DeepSeek and
 *  some other providers reject `anyOf` at the parameter level). All
 *  fields optional; runtime discriminator (`source`) determines which
 *  ones are required. ensureEvidenceShape() does the runtime check. */
export const evidenceSchema = z.object({
  source: z.enum(["note", "omop", "structured"]),
  // note fields
  note_id: z.string().optional(),
  span_offsets: z
    .array(z.number().int().nonnegative())
    .length(2)
    .optional(),
  verbatim_quote: z.string().optional(),
  doc_type: z.string().optional(),
  author_role: z.string().optional(),
  // omop / structured fields
  table: z.string().optional(),
  row_id: z.string().optional(),
  concept_id: z.number().int().optional(),
  concept_name: z.string().optional(),
  value: z.unknown().optional(),
  unit: z.string().optional(),
  // common
  evidence_date: z.string().optional(),
});

// ── shared helpers ───────────────────────────────────────────────────

/** Runtime discriminator. Throws if shape is wrong. */
export function ensureEvidenceShape(ev: any): asserts ev is {
  source: "note" | "omop" | "structured";
  [k: string]: unknown;
} {
  if (!ev || typeof ev !== "object" || !ev.source) {
    throw new Error("evidence missing");
  }
  if (ev.source === "note") {
    if (
      typeof ev.note_id !== "string" ||
      !Array.isArray(ev.span_offsets) ||
      ev.span_offsets.length !== 2 ||
      typeof ev.verbatim_quote !== "string" ||
      ev.verbatim_quote.length === 0
    ) {
      throw new Error(
        "note evidence requires note_id, span_offsets [start,end], and verbatim_quote",
      );
    }
  } else if (ev.source === "omop" || ev.source === "structured") {
    if (typeof ev.table !== "string" || ev.row_id === undefined) {
      throw new Error("omop/structured evidence requires table and row_id");
    }
  }
}

/** Validate every evidence row's source-specific shape and return
 *  them unchanged. Used by handlers that take an evidence array (or
 *  a single evidence) before constructing a UiAction. */
export function validatedEvidence<T extends Array<any> | undefined>(arr: T): T {
  if (!arr) return arr;
  for (const ev of arr as any[]) ensureEvidenceShape(ev);
  return arr;
}

/** Funnel every chat-agent action through one applyUiAction call.
 *  Returns a CallToolResult; emits a ui_action audit entry. Errors
 *  are translated to `{ok:false, ...}` payloads so the model can
 *  read them and try again. */
async function runAction(
  session: McpSession,
  hooks: ReviewToolHooks,
  action: UiAction,
  payloadSummary: () => string,
): Promise<CallToolResult> {
  const { patientId, task, sessionId } = session;
  try {
    const result = applyUiAction(
      patientId,
      task,
      "agent",
      `agent_${sessionId}`,
      action,
    );
    appendAuditEntry(
      { patientId, taskId: task.task_id, sessionId },
      {
        ts: new Date().toISOString(),
        session_id: sessionId,
        step_type: "ui_action",
        action_type: action.type,
        source: "agent",
        payload_summary: payloadSummary(),
        result_version: result.state.version,
        added_evidence_id: result.added_evidence_id,
        ...(action.type === "set_field_assessment" && {
          payload_field_id: (action.payload as { field_id?: string }).field_id,
          payload_answer: (action.payload as { answer?: unknown }).answer,
        }),
      },
    );
    hooks.onStateUpdate(result.state);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            action_type: action.type,
            version: result.state.version,
            warnings: result.warnings,
            added_evidence_id: result.added_evidence_id,
          }),
        },
      ],
    };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "error";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            action_type: action.type,
            error_code: code,
            message: (e as Error).message,
          }),
        },
      ],
    };
  }
}

/** Commit gate: before transitioning to `agent_complete`, verify
 *  every applicable, non-derived criterion has an assessment.
 *  Returns null on success, or `{ missing_criteria, unanswered_gate_deps? }`. */
export function checkCommitGate(
  task: CompiledTask,
  state: ReviewState,
): { missing_criteria: string[]; unanswered_gate_deps?: string[] } | null {
  const answers: Record<string, unknown> = {};
  for (const fa of state.field_assessments) {
    answers[fa.field_id] = fa.answer;
  }
  const missing: string[] = [];
  const unansweredGateDeps = new Set<string>();
  for (const field of task.fields) {
    if (field.derivation) continue;
    if (field.is_applicable_when) {
      const applicability = fieldApplicability(task, answers, field.id);
      if (applicability === "not_applicable") continue;
      if (applicability === "unknown") {
        const deps = gateReferencedIds(task, field.id);
        for (const dep of deps) {
          if (answers[dep] === undefined) unansweredGateDeps.add(dep);
        }
      }
    }
    const hasAssessment = state.field_assessments.some(
      (fa) => fa.field_id === field.id,
    );
    if (!hasAssessment) missing.push(field.id);
  }
  if (missing.length === 0) return null;
  const result: { missing_criteria: string[]; unanswered_gate_deps?: string[] } =
    { missing_criteria: missing };
  if (unansweredGateDeps.size > 0) {
    result.unanswered_gate_deps = [...unansweredGateDeps];
  }
  return result;
}

// ── the seven pure handler functions ─────────────────────────────────

/** Initialize per-session state. Should be called once before the
 *  first handler invocation; `loadOrCreate` ensures review_state.json
 *  exists so handlers don't race on first write. */
export function initSession(session: McpSession): void {
  loadOrCreate(session.patientId, session.task);
}

export interface SetFieldAssessmentArgs {
  field_id: string;
  answer?: unknown;
  confidence?: "low" | "medium" | "high";
  evidence?: unknown[];
  rationale?: string;
  edit_reason?:
    | "missed_evidence"
    | "misinterpreted"
    | "wrong_rule"
    | "criterion_ambiguous"
    | "other";
  edit_note?: string;
  override_of_agent?: boolean;
}

export async function setFieldAssessment(
  session: McpSession,
  args: SetFieldAssessmentArgs,
  hooks: ReviewToolHooks = noopHooks,
): Promise<CallToolResult> {
  const { override_of_agent, ...payload } = args;
  return runAction(
    session,
    hooks,
    {
      type: "set_field_assessment",
      payload: {
        ...payload,
        evidence: validatedEvidence(payload.evidence as any[] | undefined),
      } as any,
    },
    () =>
      `field_id=${args.field_id}${override_of_agent ? " override_of_agent=true" : ""}`,
  );
}

export async function getReviewState(
  session: McpSession,
): Promise<CallToolResult> {
  const state = loadReviewState(session.patientId, session.task.task_id);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(state ?? { field_assessments: [] }),
      },
    ],
  };
}

export interface SetSummaryArgs {
  brief_summary?: string;
  key_conditions?: string[];
  uncertainties?: string[];
  evidence_files?: string[];
}

export async function setSummary(
  session: McpSession,
  args: SetSummaryArgs,
  hooks: ReviewToolHooks = noopHooks,
): Promise<CallToolResult> {
  return runAction(
    session,
    hooks,
    { type: "set_summary", payload: args },
    () => `keys=${Object.keys(args).join(",")}`,
  );
}

export interface RecommendKeywordsArgs {
  topic: string;
  direct_terms?: string[];
  aliases?: string[];
  abbreviations?: string[];
  behavioral_clues?: string[];
  treatment_terms?: string[];
  negation_patterns?: string[];
}

export async function recommendKeywords(
  session: McpSession,
  args: RecommendKeywordsArgs,
  hooks: ReviewToolHooks = noopHooks,
): Promise<CallToolResult> {
  return runAction(
    session,
    hooks,
    { type: "recommend_keywords", payload: args },
    () => `topic=${args.topic}`,
  );
}

export interface SelectEvidenceArgs {
  evidence: unknown;
  rationale?: string;
  category?: "supporting" | "contradicting" | "context";
  field_id?: string;
}

export async function selectEvidence(
  session: McpSession,
  args: SelectEvidenceArgs,
  hooks: ReviewToolHooks = noopHooks,
): Promise<CallToolResult> {
  return runAction(
    session,
    hooks,
    {
      type: "select_evidence",
      payload: {
        ...args,
        evidence: validatedEvidence([args.evidence as any])[0],
      } as any,
    },
    () =>
      `category=${args.category ?? "(none)"} note=${(args.evidence as any).note_id ?? (args.evidence as any).table}`,
  );
}

export interface FindQuoteOffsetsArgs {
  note_id: string;
  snippet: string;
}

export async function findQuoteOffsets(
  session: McpSession,
  args: FindQuoteOffsetsArgs,
): Promise<CallToolResult> {
  const r = findQuoteOffsetsImpl(session.patientId, args.note_id, args.snippet);
  return {
    isError: !r.ok,
    content: [{ type: "text", text: JSON.stringify(r) }],
  };
}

export async function setReviewStatus(
  session: McpSession,
  hooks: ReviewToolHooks = noopHooks,
): Promise<CallToolResult> {
  const state = loadReviewState(session.patientId, session.task.task_id);
  if (!state) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error_code: "state_not_found",
            message:
              "Review state not found. Call set_field_assessment at least once first.",
          }),
        },
      ],
    };
  }
  const gateResult = checkCommitGate(session.task, state);
  if (gateResult) {
    const depHint =
      gateResult.unanswered_gate_deps &&
      gateResult.unanswered_gate_deps.length > 0
        ? ` Some criteria could not be evaluated because their gate dependencies (${gateResult.unanswered_gate_deps.join(", ")}) have not been answered yet — answer those leaf criteria first.`
        : "";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error_code: "incomplete_review",
            message: `Cannot mark review complete: ${gateResult.missing_criteria.length} criterion/criteria have no committed value. Commit values for every criterion before calling set_review_status.${depHint}`,
            missing_criteria: gateResult.missing_criteria,
            ...(gateResult.unanswered_gate_deps
              ? { unanswered_gate_deps: gateResult.unanswered_gate_deps }
              : {}),
          }),
        },
      ],
    };
  }
  return runAction(
    session,
    hooks,
    {
      type: "set_review_status",
      payload: { review_status: "agent_complete" },
    },
    () => "status=agent_complete",
  );
}

// ── read-side tools (added so agents stop shelling out for file reads) ──
//
// These are pure pass-throughs to @chart-review/patients helpers. They
// exist because Codex (no first-party Read/Glob tools) was reading
// notes/structured data via `cat`/`sed`/`for f in …` shell commands —
// each invocation echoes the whole file into the conversation history
// at every turn, blowing up token usage 7-10x.
//
// With these tools registered, Codex (and Claude when convenient) can
// fetch file content through structured calls instead. Tool results
// return pre-trimmed JSON; max_chars defaults to 8 KB so a single
// large note doesn't dominate context.

export const listNotesArgsSchema = z.object({});
export type ListNotesArgs = z.infer<typeof listNotesArgsSchema>;

export async function listNotesTool(
  session: McpSession,
  _args: ListNotesArgs,
): Promise<CallToolResult> {
  try {
    const notes = listNotesFn(session.patientId).map((n) => ({
      filename: n.filename,
      date: n.date,
      doctype: n.doctype,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, count: notes.length, notes }) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: (e as Error).message }) }],
    };
  }
}

export const readNoteArgsSchema = z.object({
  filename: z.string(),
  max_chars: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type ReadNoteArgs = z.infer<typeof readNoteArgsSchema>;

const READ_NOTE_DEFAULT_MAX = 8192;

export async function readNoteTool(
  session: McpSession,
  args: ReadNoteArgs,
): Promise<CallToolResult> {
  const filename = args.filename.endsWith(".txt") ? args.filename : `${args.filename}.txt`;
  let content: string;
  try {
    content = readNoteFn(session.patientId, filename);
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({
        ok: false, error: `note read failed: ${(e as Error).message}`,
      }) }],
    };
  }
  const total = content.length;
  const offset = args.offset ?? 0;
  const max = args.max_chars ?? READ_NOTE_DEFAULT_MAX;
  const slice = content.slice(offset, offset + max);
  const truncated = offset + slice.length < total;
  return {
    content: [{ type: "text", text: JSON.stringify({
      ok: true,
      filename,
      total_chars: total,
      offset,
      returned_chars: slice.length,
      truncated,
      ...(truncated ? { next_offset: offset + slice.length } : {}),
      content: slice,
    }) }],
  };
}

export const listStructuredDataArgsSchema = z.object({});
export type ListStructuredDataArgs = z.infer<typeof listStructuredDataArgsSchema>;

export async function listStructuredDataTool(
  session: McpSession,
  _args: ListStructuredDataArgs,
): Promise<CallToolResult> {
  // readStructured returns one object whose keys ARE the table names
  // (measurements, conditions, drug_exposures, …). Pull row counts per
  // table so the agent can pick which to read in full.
  try {
    const s = readStructuredFn(session.patientId);
    const tables = Object.entries(s).map(([name, rows]) => ({
      name,
      n_rows: Array.isArray(rows) ? rows.length : 0,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, tables }) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: (e as Error).message }) }],
    };
  }
}

export const readStructuredDataArgsSchema = z.object({
  table: z.string(),
  max_rows: z.number().int().positive().optional(),
});
export type ReadStructuredDataArgs = z.infer<typeof readStructuredDataArgsSchema>;

const READ_STRUCTURED_DEFAULT_MAX_ROWS = 200;

export async function readStructuredDataTool(
  session: McpSession,
  args: ReadStructuredDataArgs,
): Promise<CallToolResult> {
  try {
    const s = readStructuredFn(session.patientId);
    const raw = (s as unknown as Record<string, unknown>)[args.table];
    if (raw === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({
          ok: false, error: `unknown table '${args.table}'`,
          available: Object.keys(s),
        }) }],
      };
    }
    const rows = Array.isArray(raw) ? raw : [];
    const cap = args.max_rows ?? READ_STRUCTURED_DEFAULT_MAX_ROWS;
    const slice = rows.slice(0, cap);
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: true,
        table: args.table,
        total_rows: rows.length,
        returned_rows: slice.length,
        truncated: rows.length > slice.length,
        rows: slice,
      }) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: (e as Error).message }) }],
    };
  }
}

// ── criterion-definition tools ─────────────────────────────────────────
// The skill bundle's references/criteria/<field_id>.md files describe each
// rubric criterion (its prompt, schema, derivation rules). Agents need
// them to know what to assess. Both Claude (via Read) and Codex (via shell
// cat/sed/for-loops) were paying ~10-15 file reads for these per run.
// Exposing typed list_criteria + read_criterion eliminates the shell path.

export const listCriteriaArgsSchema = z.object({});
export type ListCriteriaArgs = z.infer<typeof listCriteriaArgsSchema>;

export async function listCriteriaTool(
  session: McpSession,
  _args: ListCriteriaArgs,
): Promise<CallToolResult> {
  try {
    const dir = path.join(phenotypeSkillDir(session.task.task_id), "references", "criteria");
    if (!fs.existsSync(dir)) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, count: 0, criteria: [] }) }] };
    }
    const criteria = fs.readdirSync(dir).sort()
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        field_id: f.replace(/\.md$/, ""),
        filename: f,
      }));
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, count: criteria.length, criteria }) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: (e as Error).message }) }],
    };
  }
}

export const readCriterionArgsSchema = z.object({
  field_id: z.string(),
});
export type ReadCriterionArgs = z.infer<typeof readCriterionArgsSchema>;

export async function readCriterionTool(
  session: McpSession,
  args: ReadCriterionArgs,
): Promise<CallToolResult> {
  try {
    if (!/^[a-zA-Z0-9_]+$/.test(args.field_id)) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({
          ok: false, error: `invalid field_id: ${args.field_id}`,
        }) }],
      };
    }
    const fp = path.join(
      phenotypeSkillDir(session.task.task_id), "references", "criteria",
      `${args.field_id}.md`,
    );
    if (!fs.existsSync(fp)) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({
          ok: false, error: `criterion '${args.field_id}' not found`,
        }) }],
      };
    }
    const content = fs.readFileSync(fp, "utf8");
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: true, field_id: args.field_id, content,
      }) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: (e as Error).message }) }],
    };
  }
}

// ── batch read tools ──────────────────────────────────────────────────
// One LLM turn per file read is wasteful — agents typically want to read
// all N notes or all M criteria as one "data fetch" step before reasoning.
// These bulk variants return everything in a single tool result, cutting
// total turn count (and therefore per-turn preamble overhead).

const BATCH_MAX = 50; // hard cap so the agent can't request 1000 at once

export const readNotesArgsSchema = z.object({
  filenames: z.array(z.string()).max(BATCH_MAX),
  max_chars_per_note: z.number().int().positive().optional(),
});
export type ReadNotesArgs = z.infer<typeof readNotesArgsSchema>;

export async function readNotesTool(
  session: McpSession,
  args: ReadNotesArgs,
): Promise<CallToolResult> {
  const per = args.max_chars_per_note ?? READ_NOTE_DEFAULT_MAX;
  const results: Array<Record<string, unknown>> = [];
  for (const raw of args.filenames) {
    const filename = raw.endsWith(".txt") ? raw : `${raw}.txt`;
    try {
      const content = readNoteFn(session.patientId, filename);
      const total = content.length;
      const slice = content.slice(0, per);
      results.push({
        filename,
        total_chars: total,
        returned_chars: slice.length,
        truncated: total > slice.length,
        content: slice,
      });
    } catch (e) {
      results.push({
        filename,
        ok: false,
        error: (e as Error).message,
      });
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify({
      ok: true, count: results.length, notes: results,
    }) }],
  };
}

export const readCriteriaArgsSchema = z.object({
  field_ids: z.array(z.string()).max(BATCH_MAX),
});
export type ReadCriteriaArgs = z.infer<typeof readCriteriaArgsSchema>;

export async function readCriteriaTool(
  session: McpSession,
  args: ReadCriteriaArgs,
): Promise<CallToolResult> {
  const dir = path.join(phenotypeSkillDir(session.task.task_id), "references", "criteria");
  const results: Array<Record<string, unknown>> = [];
  for (const field_id of args.field_ids) {
    if (!/^[a-zA-Z0-9_]+$/.test(field_id)) {
      results.push({ field_id, ok: false, error: `invalid field_id` });
      continue;
    }
    const fp = path.join(dir, `${field_id}.md`);
    if (!fs.existsSync(fp)) {
      results.push({ field_id, ok: false, error: `not found` });
      continue;
    }
    try {
      results.push({ field_id, content: fs.readFileSync(fp, "utf8") });
    } catch (e) {
      results.push({ field_id, ok: false, error: (e as Error).message });
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify({
      ok: true, count: results.length, criteria: results,
    }) }],
  };
}
