/**
 * Append-only chat-session log capturing every event in one chat
 * session: user messages, agent text, tool calls (pre + post), state
 * writes. Conforms to the platform's `trace.schema.json` shape (one
 * entry per JSONL line) so it can be loaded by `chart_review.faithfulness`
 * or any downstream replayer.
 *
 *   reviews/<patient_id>/<task_id>/chat/<session_id>.jsonl
 *
 * The PreToolUse + PostToolUse hooks below are registered on the
 * Claude Agent SDK session and fire for every tool call (built-in
 * Read/Glob/Grep + the in-process MCP tools). They never block the
 * agent — they return `{}` (empty SyncHookJSONOutput).
 */

import fs from "fs";
import path from "path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { getReviewsRootOverride } from "@chart-review/reviews-context";

/** Exported for tests that want to know the default value. Not used
 *  internally after the lazy accessor below was introduced. */
export const REVIEWS_ROOT =
  process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");

/** Always re-read the override / env var so test code can change it
 *  without having to reset the module. The override (set by
 *  `withReviewsRoot` from reviews-context.ts) lets the batch-run
 *  driver redirect writes per-async-chain. */
function reviewsRoot(): string {
  const override = getReviewsRootOverride();
  if (override) return override;
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

const MAX_RESULT_PREVIEW = 2000;

export interface AuditCoordinates {
  patientId: string;
  taskId: string;
  sessionId: string;
}

interface BaseEntry {
  ts: string;
  session_id: string;
  step_type: string;
}

export type AuditEntry =
  | (BaseEntry & {
      step_type: "session_start";
      patient_id: string;
      task_id: string;
      task_document_sha?: string;
      model: string;
      cwd: string;
    })
  | (BaseEntry & {
      step_type: "user_message";
      text: string;
    })
  | (BaseEntry & {
      step_type: "assistant_text";
      text: string;
    })
  | (BaseEntry & {
      step_type: "tool_call_pre";
      tool_use_id?: string;
      tool_name: string;
      tool_input: unknown;
    })
  | (BaseEntry & {
      step_type: "tool_call_post";
      tool_use_id?: string;
      tool_name: string;
      result_preview: string;
      result_truncated: boolean;
    })
  | (BaseEntry & {
      step_type: "ui_action";
      action_type: string;
      source: "agent" | "reviewer";
      payload_summary: string;
      result_version?: number;
      added_evidence_id?: string;
      payload_field_id?: string;
      payload_answer?: unknown;
    })
  | (BaseEntry & {
      step_type: "state_write";
      target: string; // path written
      version: number;
      by: string;
    })
  | (BaseEntry & {
      step_type: "result";
      success: boolean;
      cost_usd?: number;
      duration_ms?: number;
    })
  | (BaseEntry & {
      step_type: "error";
      message: string;
    })
  | (BaseEntry & {
      step_type: "accept_agent_draft";
      field_id: string;
      agent_answer_sha: string;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "bulk_accept";
      fields: string[];
      count: number;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "record_validated";
      gate_results: {
        all_terminal: boolean;
        faithfulness_pass: boolean;
        alerts_dismissed: boolean;
        every_leaf_touched_or_bulk_accepted: boolean;
      };
      all_passed: boolean;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "blind_submit";
      field_id: string;
      blind_answer_sha: string;
      agent_answer_sha: string;
      divergent: boolean;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "reviewer_session_summary";
      notes_opened: number;
      total_dwell_ms: number;
      searches_run: number;
      ts_open: string;
      ts_close: string;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "record_locked";
      lock_task_sha: string;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "drift_alert";
      field_id: string;
      baseline_rate: number;
      current_rate: number;
      delta_pp: number;
      reviewer_id: "system";
    })
  | (BaseEntry & {
      step_type: "role_c_auto_run";
      field_id: string;
      drift_alert_count: number;
      triggered_by: "system";
    })
  | (BaseEntry & {
      step_type: "record_assigned";
      patient_id: string;
      reviewer_id: string;
      assigned_by: string;
    })
  | (BaseEntry & {
      step_type: "record_unassigned";
      patient_id: string;
      reviewer_id: string;
      unassigned_by: string;
    })
  | (BaseEntry & {
      step_type: "record_superseded";
      from_sha: string;
      to_sha: string;
      archived_path: string;
      triggered_by: string;
    })
  | (BaseEntry & {
      step_type: "migration_run";
      from_sha: string;
      to_sha: string;
      affected_count: number;
      triggered_by: string;
    });

function chatLogPath(c: AuditCoordinates): string {
  return path.join(
    reviewsRoot(),
    c.patientId,
    c.taskId,
    "chat",
    `${c.sessionId}.jsonl`,
  );
}

export function appendAuditEntry(c: AuditCoordinates, entry: AuditEntry): void {
  const p = chatLogPath(c);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + "\n");
}

export function readAuditEntries(c: AuditCoordinates): AuditEntry[] {
  const p = chatLogPath(c);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditEntry);
}

/** #43 — per-record adjudication trail. Walks every audit session for the
 *  patient×task and returns entries scoped to a specific field, in
 *  chronological order. The CriterionPane renders this as "who-did-what" so
 *  the reviewer can see the field's history without opening the full audit
 *  view. */
export function readFieldHistory(
  patientId: string,
  taskId: string,
  fieldId: string,
): AuditEntry[] {
  const dir = path.join(reviewsRoot(), patientId, taskId, "chat");
  if (!fs.existsSync(dir)) return [];
  const out: AuditEntry[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.replace(/\.jsonl$/, "");
    const lines = fs
      .readFileSync(path.join(dir, name), "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as AuditEntry;
        if (matchesField(e, fieldId)) {
          out.push({ ...e, session_id: e.session_id ?? sessionId });
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  // Sort by ts (string-compare works for ISO timestamps).
  out.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  return out;
}

function matchesField(e: AuditEntry, fieldId: string): boolean {
  // ui_action entries carry payload_field_id; accept_agent_draft + a few
  // others carry field_id directly. Older record_validated / record_locked
  // entries are global per-record so we don't include them.
  const anyE = e as unknown as { payload_field_id?: string; field_id?: string; fields?: string[] };
  if (anyE.payload_field_id === fieldId) return true;
  if (anyE.field_id === fieldId) return true;
  if (Array.isArray(anyE.fields) && anyE.fields.includes(fieldId)) return true;
  return false;
}

export interface AuditSessionSummary {
  session_id: string;
  entry_count: number;
  started_at?: string;
  ended_at?: string;
  bytes: number;
}

/** Enumerate every chat session JSONL on disk for a patient×task. */
export function listAuditSessions(
  patientId: string,
  taskId: string,
): AuditSessionSummary[] {
  const dir = path.join(reviewsRoot(), patientId, taskId, "chat");
  if (!fs.existsSync(dir)) return [];
  const out: AuditSessionSummary[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const session_id = name.replace(/\.jsonl$/, "");
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    const lines = fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const startedAt = lines[0] ? safeTs(lines[0]) : undefined;
    const endedAt = lines[lines.length - 1]
      ? safeTs(lines[lines.length - 1])
      : undefined;
    out.push({
      session_id,
      entry_count: lines.length,
      started_at: startedAt,
      ended_at: endedAt,
      bytes: stat.size,
    });
  }
  // Most recent first.
  out.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return out;
}

function safeTs(line: string): string | undefined {
  try {
    return (JSON.parse(line) as { ts?: string }).ts;
  } catch {
    return undefined;
  }
}

function preview(value: unknown): { text: string; truncated: boolean } {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  if (s.length > MAX_RESULT_PREVIEW) {
    return {
      text: s.slice(0, MAX_RESULT_PREVIEW) + " …[truncated]",
      truncated: true,
    };
  }
  return { text: s, truncated: false };
}

/**
 * Build a {PreToolUse, PostToolUse} hook pair bound to one chat session.
 * Every tool the agent invokes — Read/Glob/Grep, mcp__chart_review_state__*,
 * and any future MCP tools — produces a paired entry in the session JSONL.
 */
export function buildAuditHooks(c: AuditCoordinates) {
  const pre = async (input: any) => {
    if (input?.hook_event_name !== "PreToolUse") return {};
    appendAuditEntry(c, {
      ts: new Date().toISOString(),
      session_id: c.sessionId,
      step_type: "tool_call_pre",
      tool_use_id: input.tool_use_id,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
    });
    return {};
  };

  const post = async (input: any) => {
    if (input?.hook_event_name !== "PostToolUse") return {};
    const { text, truncated } = preview(input.tool_response);
    appendAuditEntry(c, {
      ts: new Date().toISOString(),
      session_id: c.sessionId,
      step_type: "tool_call_post",
      tool_use_id: input.tool_use_id,
      tool_name: input.tool_name,
      result_preview: text,
      result_truncated: truncated,
    });
    return {};
  };

  return { pre, post };
}
