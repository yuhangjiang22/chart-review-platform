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
    // Return the rejection as a NORMAL (non-isError) tool result. With
    // isError:true, langchain-mcp-adapters raises a ToolException that
    // deepagents' middleware re-raises — crashing the whole run instead of
    // letting the model react. As a recoverable result the model reads
    // {ok:false,...} and can retry (the documented intent of this funnel).
    const hint =
      code === "faithfulness_failed"
        ? "Evidence offsets did not match the verbatim_quote. Call find_quote_offsets to get the exact offsets for your quote, then retry set_field_assessment."
        : undefined;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            action_type: action.type,
            error_code: code,
            message: (e as Error).message,
            ...(hint ? { hint } : {}),
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

/**
 * Some tool-calling models (e.g. Qwen3) occasionally wrap the scalar answer in
 * a single-key object — `{ "<field_id>": "sarcoma" }` or `{ "answer": "..." }`
 * — instead of passing the bare value. That nested shape renders as
 * "[object Object]" in the UI and can't be scored. Unwrap a single-key
 * `{field_id|answer|value: scalar}` to the scalar; leave anything else as-is.
 */
function unwrapNestedAnswer(fieldId: string, answer: unknown, enumVals?: unknown[]): unknown {
  let a = answer;
  if (a && typeof a === "object" && !Array.isArray(a)) {
    const obj = a as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && (keys[0] === fieldId || keys[0] === "answer" || keys[0] === "value")) {
      a = obj[keys[0]];
    } else if ("value" in obj) {
      // typed-answer wrapper, e.g. { type: "boolean", value: false }
      a = obj.value;
    }
  }
  // Some models emit a JS boolean for a yes/no-style field. Map it to the
  // field's matching enum value, honoring whichever convention the rubric uses
  // (yes/no OR true/false); fall back to yes/no when there's no enum to match.
  if (typeof a === "boolean") {
    const wanted = a ? ["yes", "true"] : ["no", "false"];
    if (Array.isArray(enumVals)) {
      const match = enumVals.find((v) => wanted.includes(String(v).toLowerCase()));
      if (match !== undefined) return match;
    }
    return a ? "yes" : "no";
  }
  return a;
}

export async function setFieldAssessment(
  session: McpSession,
  args: SetFieldAssessmentArgs,
  hooks: ReviewToolHooks = noopHooks,
): Promise<CallToolResult> {
  const { override_of_agent, ...payload } = args;
  // The field's allowed answers (enum), used to normalize a raw boolean answer
  // to the right enum value for THIS field — generic across tasks/conventions.
  const field = (
    session.task.fields as Array<{ field_id?: string; id?: string; answer_schema?: { enum?: unknown[] } }> | undefined
  )?.find((f) => (f.field_id ?? f.id) === payload.field_id);
  const enumVals = field?.answer_schema?.enum;
  return runAction(
    session,
    hooks,
    {
      type: "set_field_assessment",
      payload: {
        ...payload,
        answer: unwrapNestedAnswer(payload.field_id, (payload as { answer?: unknown }).answer, enumVals),
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

export const searchNotesArgsSchema = z.object({
  keyword: z.string().min(1),
  max_matches: z.number().int().positive().optional(),
  context_chars: z.number().int().nonnegative().optional(),
});
export type SearchNotesArgs = z.infer<typeof searchNotesArgsSchema>;

/** Case-insensitive substring search across all of the patient's notes.
 *  Returns {filename, offset, snippet} hits so the agent can jump to the
 *  relevant span on a long chart instead of reading every note. */
export async function searchNotesTool(
  session: McpSession,
  args: SearchNotesArgs,
): Promise<CallToolResult> {
  try {
    const kw = args.keyword.toLowerCase();
    const ctx = args.context_chars ?? 80;
    const cap = args.max_matches ?? 20;
    const hits: Array<{ filename: string; offset: number; snippet: string }> = [];
    for (const n of listNotesFn(session.patientId)) {
      if (hits.length >= cap) break;
      let text: string;
      try { text = readNoteFn(session.patientId, n.filename); } catch { continue; }
      const lc = text.toLowerCase();
      let i = lc.indexOf(kw);
      while (i !== -1 && hits.length < cap) {
        const start = Math.max(0, i - ctx);
        const end = Math.min(text.length, i + kw.length + ctx);
        hits.push({ filename: n.filename, offset: i,
                    snippet: (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "") });
        i = lc.indexOf(kw, i + kw.length);
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: true, keyword: args.keyword, match_count: hits.length, matches: hits,
      }) }],
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
    // Derived fields (e.g. disease_extent) are computed by the platform from
    // their leaf inputs — the agent must NOT extract them. Hide them from the
    // criteria listing so the agent only commits leaf fields; otherwise it
    // wastes a commit on the derived field and tends to drop a real leaf.
    const derived = new Set(
      ((session.task.fields ?? []) as Array<{ field_id?: string; id?: string; derivation?: string }>)
        .filter((f) => f.derivation)
        .map((f) => f.field_id ?? f.id),
    );
    const criteria = fs.readdirSync(dir).sort()
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        field_id: f.replace(/\.md$/, ""),
        filename: f,
      }))
      .filter((c) => !derived.has(c.field_id));
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
