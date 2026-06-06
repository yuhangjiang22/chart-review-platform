// Transport-neutral MCP handlers for adherence tasks.
//
// Adherence has its own MCP surface (parallel to chart_review_state for
// phenotype and chart_review_ner for NER). The agent commits one
// QuestionAnswer per question via `set_question_answer`; the platform
// later runs the deterministic rule engine + nuanced LLM judge over the
// collected answers to produce rule_verdicts.
//
// Storage shape (in ReviewState):
//   question_answers?: QuestionAnswer[]
//   rule_verdicts?:    RuleVerdict[]   ← written by post-agent pass
//   task_kind:         "adherence"
//   validated_questions?: string[]     ← agent doesn't touch
//   validated_rules?:     string[]     ← agent doesn't touch

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { CompiledTask } from "@chart-review/tasks";
import type { QuestionAnswer } from "@chart-review/platform-types";
import { loadOrCreate, writeReviewState } from "@chart-review/domain-review";
import {
  loadAdherenceSkill,
  verifyAnswer,
  type AdherenceSkill,
  type QuestionDefinition,
} from "@chart-review/pipeline-extract-adherence";

export type CallToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

export interface AdherenceMcpSession {
  patientId: string;
  task: CompiledTask;
  sessionId: string;
}

// Cache the skill load — questions/rules YAML is stable for the run.
const _skillCache = new Map<string, AdherenceSkill>();
function getSkill(taskId: string): AdherenceSkill {
  let s = _skillCache.get(taskId);
  if (!s) { s = loadAdherenceSkill(taskId); _skillCache.set(taskId, s); }
  return s;
}

function ok(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }) }] };
}
function err(message: string, extras: Record<string, unknown> = {}): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...extras }) }],
  };
}

// ── list_questions(tier?) ─────────────────────────────────────────────

export const listQuestionsArgsSchema = z.object({
  tier: z.number().int().nonnegative().optional(),
});
export type ListQuestionsArgs = z.infer<typeof listQuestionsArgsSchema>;

export async function listQuestions(
  session: AdherenceMcpSession,
  args: ListQuestionsArgs,
): Promise<CallToolResult> {
  try {
    const skill = getSkill(session.task.task_id);
    const tiers = [...skill.questions_by_tier.keys()].sort((a, b) => a - b);
    const questions: Array<{ question_id: string; tier: number; text: string; answer_schema?: unknown; depends_on?: string[] }> = [];
    for (const t of tiers) {
      if (args.tier !== undefined && t !== args.tier) continue;
      for (const q of skill.questions_by_tier.get(t) ?? []) {
        questions.push({
          question_id: q.question_id,
          tier: q.tier,
          text: q.text,
          answer_schema: q.answer_schema,
          depends_on: q.depends_on,
        });
      }
    }
    return ok({ count: questions.length, questions });
  } catch (e) {
    return err(`failed to load skill: ${(e as Error).message}`);
  }
}

// ── read_question(question_id) ────────────────────────────────────────

export const readQuestionArgsSchema = z.object({
  question_id: z.string(),
});
export type ReadQuestionArgs = z.infer<typeof readQuestionArgsSchema>;

export async function readQuestion(
  session: AdherenceMcpSession,
  args: ReadQuestionArgs,
): Promise<CallToolResult> {
  const skill = getSkill(session.task.task_id);
  for (const [, list] of skill.questions_by_tier) {
    const q = list.find((x) => x.question_id === args.question_id);
    if (q) return ok({ question: q });
  }
  return err(`question_id '${args.question_id}' not found`);
}

// ── set_question_answer ───────────────────────────────────────────────

const evidenceSchema = z.object({
  note_id: z.string(),
  quote: z.string(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
});

export const setQuestionAnswerArgsSchema = z.object({
  question_id: z.string(),
  // Loose schema — the question's own answer_schema constrains the
  // concrete type; the handler coerces with the question's typing rules.
  answer: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(evidenceSchema).optional(),
  reasoning: z.string().optional(),
  verifier_status: z.enum(["confirmed", "contradicted", "no_check"]).optional(),
});
export type SetQuestionAnswerArgs = z.infer<typeof setQuestionAnswerArgsSchema>;

function findQuestion(skill: AdherenceSkill, qid: string): QuestionDefinition | null {
  for (const [, list] of skill.questions_by_tier) {
    const q = list.find((x) => x.question_id === qid);
    if (q) return q;
  }
  return null;
}

function coerce(raw: unknown, q: QuestionDefinition): QuestionAnswer["answer"] {
  if (raw === undefined || raw === null) return null;
  const s = q.answer_schema;
  if (!s) return raw as QuestionAnswer["answer"];
  if (s.type === "boolean" && typeof raw !== "boolean") {
    if (raw === "true" || raw === 1) return true;
    if (raw === "false" || raw === 0) return false;
    return null;
  }
  if (s.type === "number" && typeof raw !== "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (s.enum && !s.enum.includes(raw as string | number | boolean)) {
    return null;
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  return null;
}

export async function setQuestionAnswer(
  session: AdherenceMcpSession,
  args: SetQuestionAnswerArgs,
): Promise<CallToolResult> {
  const skill = getSkill(session.task.task_id);
  const q = findQuestion(skill, args.question_id);
  if (!q) return err(`question_id '${args.question_id}' not found`);

  const coerced = coerce(args.answer, q);
  // Coerce-to-null is OK (means "I couldn't determine") — agents are
  // explicitly told to prefer null over guessing.

  // Verifier post-pass: cross-check the coerced answer against the
  // patient's OMOP structured data. The deterministic verdict
  // supersedes whatever the agent claimed in args.verifier_status —
  // we trust structured data over agent self-reporting. When no
  // structured signal is available the result is "no_check" (default).
  let verifierStatus: "confirmed" | "contradicted" | "no_check" | undefined;
  let verifierNote: string | undefined;
  try {
    const structured = readStructuredFn(session.patientId);
    const v = verifyAnswer(args.question_id, coerced, structured);
    verifierStatus = v.status;
    verifierNote = v.note;
  } catch (e) {
    verifierStatus = "no_check";
    verifierNote = `verifier load failed: ${(e as Error).message}`;
  }

  const state = loadOrCreate(session.patientId, session.task);
  state.task_kind = "adherence";
  const list = state.question_answers ?? [];
  const idx = list.findIndex((a) => a.question_id === args.question_id);
  const next: QuestionAnswer = {
    question_id: args.question_id,
    tier: q.tier,
    answer: coerced,
    confidence: args.confidence,
    evidence: args.evidence,
    reasoning: args.reasoning,
    verifier_status: verifierStatus,
    verifier_note: verifierNote,
    source: "agent",
    ts: new Date().toISOString(),
  };
  if (idx >= 0) list[idx] = next; else list.push(next);
  state.question_answers = list;
  state.version += 1;
  state.updated_at = new Date().toISOString();
  state.updated_by = "agent";
  writeReviewState(session.patientId, session.task.task_id, state);

  // Surface contradictions loudly in the tool response so the agent
  // sees them on the spot. The verifier already persisted the verdict
  // on the answer; this `warning` makes the feedback loop in SKILL.md
  // actually fire — the agent reads it, re-checks the structured
  // source, and can re-commit the corrected value.
  const isContradicted = verifierStatus === "contradicted";
  return ok({
    question_id: args.question_id,
    version: state.version,
    verifier_status: verifierStatus,
    verifier_note: verifierNote,
    ...(isContradicted ? {
      warning: `OMOP CONTRADICTS YOUR ANSWER. ${verifierNote ?? ""} `
        + "Re-read the structured table referenced in this note and call "
        + "set_question_answer again with the corrected value. If you "
        + "intentionally disagree with the structured row, commit the same "
        + "answer and explain why in the 'reasoning' field.",
    } : {}),
  });
}

// ── get_adherence_state ───────────────────────────────────────────────

export async function getAdherenceState(
  session: AdherenceMcpSession,
): Promise<CallToolResult> {
  const state = loadOrCreate(session.patientId, session.task);
  return ok({
    patient_id: state.patient_id,
    task_id: state.task_id,
    version: state.version,
    question_answers: state.question_answers ?? [],
    answered_count: (state.question_answers ?? []).length,
  });
}

// ── set_review_status ────────────────────────────────────────────────
// Signals the agent considers the chart fully assessed. No commit-gate
// here (unlike phenotype) — adherence's gate is downstream (rule engine
// evaluates after agent loop completes).

export const setReviewStatusArgsSchema = z.object({
  status: z.literal("complete"),
});
export type SetReviewStatusArgs = z.infer<typeof setReviewStatusArgsSchema>;

export async function setReviewStatus(
  session: AdherenceMcpSession,
  _args: SetReviewStatusArgs,
): Promise<CallToolResult> {
  const state = loadOrCreate(session.patientId, session.task);
  state.review_status = "agent_complete";
  state.task_kind = "adherence";
  state.version += 1;
  state.updated_at = new Date().toISOString();
  state.updated_by = "agent";
  writeReviewState(session.patientId, session.task.task_id, state);
  return ok({ status: "agent_complete", answered_count: (state.question_answers ?? []).length });
}

// ── read-side passthroughs (notes + OMOP structured data) ────────────

import {
  listNotes as listNotesFn,
  readNote as readNoteFn,
  readStructured as readStructuredFn,
} from "@chart-review/patients";

export const listNotesArgsSchema = z.object({});
export async function listNotesTool(
  session: AdherenceMcpSession,
): Promise<CallToolResult> {
  try {
    const notes = listNotesFn(session.patientId).map((n) => ({
      filename: n.filename, date: n.date, doctype: n.doctype,
    }));
    return ok({ count: notes.length, notes });
  } catch (e) { return err((e as Error).message); }
}

export const readNotesArgsSchema = z.object({
  filenames: z.array(z.string()).max(50),
  max_chars_per_note: z.number().int().positive().optional(),
});
export type ReadNotesArgs = z.infer<typeof readNotesArgsSchema>;

// ── search_notes(queries) ─────────────────────────────────────────────
//
// Keyword search across the patient's notes — the single biggest
// accuracy lever per the ACCR design (lung cancer: 83.5% → 92.4% when
// search was added). Multiple OR'd query terms per call; each match
// returns the note filename, character offset, and a ±120-char window
// of surrounding context. Case-insensitive, sub-string match. Semantic
// search is a follow-up (would require an embedding index per patient).
//
// Why keyword first: it's deterministic, cheap, and resolves >90% of
// the asthma-adherence retrieval needs (medication names, ACT scores,
// spirometry values, "action plan" phrasing all have stable surface
// forms). Semantic search shines on prose-heavy questions where the
// reviewer's wording differs from the chart's — add when we hit that.

export const searchNotesArgsSchema = z.object({
  queries: z.array(z.string().min(1)).min(1).max(20),
  max_hits_per_query: z.number().int().positive().optional(),
  context_chars: z.number().int().positive().optional(),
});
export type SearchNotesArgs = z.infer<typeof searchNotesArgsSchema>;

interface SearchHit {
  query: string;
  filename: string;
  date?: string;
  doctype?: string;
  offset: number;
  snippet: string;
}

const SEARCH_DEFAULT_MAX_HITS = 5;
const SEARCH_DEFAULT_CONTEXT = 120;
const SEARCH_HARD_CAP_PER_QUERY = 25;

export async function searchNotesTool(
  session: AdherenceMcpSession,
  args: SearchNotesArgs,
): Promise<CallToolResult> {
  const maxHits = Math.min(
    args.max_hits_per_query ?? SEARCH_DEFAULT_MAX_HITS,
    SEARCH_HARD_CAP_PER_QUERY,
  );
  const ctx = args.context_chars ?? SEARCH_DEFAULT_CONTEXT;
  try {
    const notes = listNotesFn(session.patientId);
    const hits: SearchHit[] = [];
    const perQueryCount = new Map<string, number>();
    for (const q of args.queries) {
      const needle = q.toLowerCase();
      for (const n of notes) {
        if ((perQueryCount.get(q) ?? 0) >= maxHits) break;
        let body: string;
        try { body = readNoteFn(session.patientId, n.filename); }
        catch { continue; }
        const hay = body.toLowerCase();
        let from = 0;
        while ((perQueryCount.get(q) ?? 0) < maxHits) {
          const idx = hay.indexOf(needle, from);
          if (idx < 0) break;
          const start = Math.max(0, idx - ctx);
          const end = Math.min(body.length, idx + needle.length + ctx);
          // Re-slice from the ORIGINAL body to preserve case in the
          // returned snippet.
          const snippet = body.slice(start, end).replace(/\s+/g, " ").trim();
          hits.push({
            query: q,
            filename: n.filename,
            date: n.date,
            doctype: n.doctype,
            offset: idx,
            snippet: (start > 0 ? "…" : "") + snippet + (end < body.length ? "…" : ""),
          });
          perQueryCount.set(q, (perQueryCount.get(q) ?? 0) + 1);
          from = idx + needle.length;
        }
      }
    }
    return ok({
      total_hits: hits.length,
      per_query: Object.fromEntries(
        args.queries.map((q) => [q, perQueryCount.get(q) ?? 0]),
      ),
      hits,
    });
  } catch (e) { return err((e as Error).message); }
}

export async function readNotesTool(
  session: AdherenceMcpSession,
  args: ReadNotesArgs,
): Promise<CallToolResult> {
  const per = args.max_chars_per_note ?? 8192;
  const out: Array<Record<string, unknown>> = [];
  for (const raw of args.filenames) {
    const filename = raw.endsWith(".txt") ? raw : `${raw}.txt`;
    try {
      const c = readNoteFn(session.patientId, filename);
      out.push({
        filename, total_chars: c.length, returned_chars: Math.min(c.length, per),
        truncated: c.length > per,
        content: c.slice(0, per),
      });
    } catch (e) {
      out.push({ filename, ok: false, error: (e as Error).message });
    }
  }
  return ok({ count: out.length, notes: out });
}
// ── list_structured_data / read_structured_data ──────────────────────
//
// Asthma adherence relies on real EHR signals — med lists, ACT scores,
// spirometry values, ED encounters — that arrive as OMOP-shaped rows,
// not free text. Mirror the phenotype MCP's tool pair (cheaper for the
// agent than scraping notes, and accurate when present): one tool to
// list available tables + row counts, one to read a table's rows.
//
// Tables are the standard six in <patient>/omop/: conditions, drugs,
// measurements, observations, procedures, encounters. Missing files
// resolve to empty arrays — the agent should fall back to notes when a
// table is empty.

export const listStructuredDataArgsSchema = z.object({});
export type ListStructuredDataArgs = z.infer<typeof listStructuredDataArgsSchema>;

export async function listStructuredDataTool(
  session: AdherenceMcpSession,
): Promise<CallToolResult> {
  try {
    const s = readStructuredFn(session.patientId);
    const tables: Array<{ name: string; n_rows: number }> = [];
    for (const [name, rows] of Object.entries(s)) {
      if (name === "index_date") continue;
      tables.push({ name, n_rows: Array.isArray(rows) ? rows.length : 0 });
    }
    return ok({
      tables,
      index_date: (s as unknown as { index_date?: string }).index_date,
    });
  } catch (e) { return err((e as Error).message); }
}

export const readStructuredDataArgsSchema = z.object({
  table: z.string(),
  max_rows: z.number().int().positive().optional(),
});
export type ReadStructuredDataArgs = z.infer<typeof readStructuredDataArgsSchema>;

const READ_STRUCTURED_DEFAULT_MAX_ROWS = 200;

export async function readStructuredDataTool(
  session: AdherenceMcpSession,
  args: ReadStructuredDataArgs,
): Promise<CallToolResult> {
  try {
    const s = readStructuredFn(session.patientId);
    const raw = (s as unknown as Record<string, unknown>)[args.table];
    if (raw === undefined) {
      return err(`unknown table '${args.table}'`, {
        available: Object.keys(s).filter((k) => k !== "index_date"),
      });
    }
    const rows = Array.isArray(raw) ? raw : [];
    const cap = args.max_rows ?? READ_STRUCTURED_DEFAULT_MAX_ROWS;
    const slice = rows.slice(0, cap);
    return ok({
      table: args.table,
      total_rows: rows.length,
      returned_rows: slice.length,
      truncated: rows.length > cap,
      rows: slice,
    });
  } catch (e) { return err((e as Error).message); }
}

// Silence "imported but only used in types" linter — these are pure
// data passthroughs already exercised above.
void path; void fs;
