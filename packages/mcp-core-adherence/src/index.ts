// Transport-neutral MCP handlers for adherence tasks.
//
// Adherence has its own write surface (parallel to set_field_assessment
// for phenotype and set_span_label for NER). The agent commits one
// QuestionAnswer per question via `set_question_answer`; after the agent
// loop completes the platform runs the deterministic rule engine over the
// collected answers to produce rule_verdicts (no LLM judge in concur's MVP).
//
// Storage shape (in ReviewState, union-shaped review_state.json):
//   question_answers?: QuestionAnswer[]   ← written here, one per question
//   rule_verdicts?:    RuleVerdict[]       ← written by the post-agent pass
//   task_kind:         "adherence"
//   validated_questions?: string[]         ← reviewer-only, agent never touches
//   validated_rules?:     string[]         ← reviewer-only, agent never touches
//
// These handlers REUSE concur's McpSession / CallToolResult types and its
// note/structured-data readers. The stdio server (mcp-server-stdio) wraps
// them for the deepagents subprocess; they are gated to adherence runs there.
//
// Faithfulness: set_question_answer routes every NOTE evidence quote through
// @chart-review/faithfulness `verifyEvidence` — the same gate the phenotype
// set_field_assessment uses (concur CLAUDE.md gotcha #3). A genuinely-absent
// quote rejects the write (recoverable {ok:false} result with a
// find_quote_offsets hint); a real quote at the wrong offsets is accepted
// with corrected offsets written back onto the stored evidence.
//
// Verifier DEFERRED (MVP): the answer is stored with verifier_status:"no_check".
// No OMOP cross-check, no contradiction warning (the riskiest v2 sub-piece).

import { z } from "zod";
import type { CompiledTask } from "@chart-review/tasks";
import type { QuestionAnswer } from "@chart-review/platform-types";
import { loadOrCreate, writeReviewState } from "@chart-review/domain-review";
import { verifyEvidence } from "@chart-review/faithfulness";
import { readStructured } from "@chart-review/patients";
import {
  loadAdherenceSkill,
  type AdherenceSkill,
  type QuestionDefinition,
} from "@chart-review/pipeline-extract-adherence";

/** CallToolResult shape mirrored from the MCP spec (same shape mcp-core uses). */
export type CallToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

/** Per-(patient, task) session context — same shape as mcp-core's McpSession. */
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
  // Return as a NORMAL (non-isError) result. With isError:true,
  // langchain-mcp-adapters raises a ToolException that deepagents'
  // middleware re-raises — crashing the whole run instead of letting the
  // model read {ok:false,...} and retry (mirrors mcp-core's runAction).
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...extras }) }],
  };
}

function findQuestion(skill: AdherenceSkill, qid: string): QuestionDefinition | null {
  for (const [, list] of skill.questions_by_tier) {
    const q = list.find((x) => x.question_id === qid);
    if (q) return q;
  }
  return null;
}

/** Verify one evidence array: OMOP rows pass through; note quotes go
 *  through the faithfulness gate (absent quote → error string; real quote
 *  at wrong offsets → corrected offsets). Returns the verified list or
 *  an error message. */
function verifyAnswerEvidence(
  patientId: string,
  evidence: Array<z.infer<typeof evidenceSchema>>,
): { ok: true; verified: NonNullable<QuestionAnswer["evidence"]> } | { ok: false; error: string } {
  const verified: NonNullable<QuestionAnswer["evidence"]> = [];
  for (const ev of evidence) {
    if ((ev as { source?: string }).source === "omop") {
      const o = ev as { table: string; row_id?: string; concept_id?: number; concept_name?: string };
      verified.push({ source: "omop", table: o.table, row_id: o.row_id, concept_id: o.concept_id, concept_name: o.concept_name });
      continue;
    }
    const n = ev as { note_id: string; quote: string; start?: number | null; end?: number | null };
    const start = n.start ?? 0;
    const end = n.end ?? (start + (n.quote?.length ?? 0));
    const result = verifyEvidence(patientId, {
      source: "note", note_id: n.note_id, span_offsets: [start, end], verbatim_quote: n.quote,
    });
    if (result.status === "fail") {
      return { ok: false, error: `faithfulness check failed for evidence in note '${n.note_id}': ${result.detail ?? "quote not found"}` };
    }
    const [cs, ce] = result.corrected_offsets ?? [start, end];
    verified.push({ source: "note", note_id: n.note_id, quote: n.quote, start: cs, end: ce });
  }
  return { ok: true, verified };
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
    const questions: Array<{
      question_id: string; tier: number; text: string;
      answer_schema?: unknown; depends_on?: string[]; retrieval_hints?: string;
    }> = [];
    for (const t of tiers) {
      if (args.tier !== undefined && t !== args.tier) continue;
      for (const q of skill.questions_by_tier.get(t) ?? []) {
        questions.push({
          question_id: q.question_id,
          tier: q.tier,
          text: q.text,
          answer_schema: q.answer_schema,
          depends_on: q.depends_on,
          retrieval_hints: q.retrieval_hints,
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
  try {
    const skill = getSkill(session.task.task_id);
    const q = findQuestion(skill, args.question_id);
    if (q) return ok({ question: q });
    return err(`question_id '${args.question_id}' not found`);
  } catch (e) {
    return err(`failed to load skill: ${(e as Error).message}`);
  }
}

// ── set_question_answer ───────────────────────────────────────────────

// Evidence is EITHER a NOTE quote (faithfulness-checked) OR an OMOP structured
// row (source:"omop", table [+ row_id]). Answers determined from a structured
// lookup must cite the row, not a note (enforced below for foundation-backed
// questions). Try the omop shape first so a source:"omop" item isn't misread.
const noteEvidenceSchema = z.object({
  source: z.literal("note").optional(),
  note_id: z.string(),
  quote: z.string(),
  // `.nullish()`: agents pass explicit null for offsets they didn't compute.
  start: z.number().int().nonnegative().nullish(),
  end: z.number().int().nonnegative().nullish(),
});
const omopEvidenceSchema = z.object({
  source: z.literal("omop"),
  table: z.string(),
  row_id: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? undefined : String(v))),
  concept_id: z.number().optional(),
  concept_name: z.string().optional(),
});
export const evidenceSchema = z.union([omopEvidenceSchema, noteEvidenceSchema]);

export const setQuestionAnswerArgsSchema = z.object({
  question_id: z.string(),
  // Loose schema — the question's own answer_schema constrains the
  // concrete type; the handler coerces with the question's typing rules.
  answer: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(evidenceSchema).optional(),
  reasoning: z.string().optional(),
});
export type SetQuestionAnswerArgs = z.infer<typeof setQuestionAnswerArgsSchema>;

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
  let skill: AdherenceSkill;
  try {
    skill = getSkill(session.task.task_id);
  } catch (e) {
    return err(`failed to load skill: ${(e as Error).message}`);
  }
  const q = findQuestion(skill, args.question_id);
  if (!q) return err(`question_id '${args.question_id}' not found`);

  const coerced = coerce(args.answer, q);
  // Coerce-to-null is OK (means "I couldn't determine") — agents are
  // explicitly told to prefer null over guessing.

  // OMOP-PROVENANCE (UPGRADE, non-blocking): answers determined from a
  // structured lookup should carry OMOP provenance. A HARD reject was tried and
  // backfired — it triggered retry storms and drove the agent to null the answer
  // to escape the gate (breaking eligibility). Instead we UPGRADE: if the agent
  // committed a structured-sourced non-null answer WITHOUT citing the row, and
  // the source table has data for this patient, we attach a table-level omop
  // provenance pointer ourselves (below). The agent may still cite a specific
  // row (schema accepts it) — then no upgrade is needed.
  const STRUCTURED_SOURCED: Record<string, string> = {
    "T0-AgeOk": "demographics",
    "T0-AgeBand": "demographics",
    "T0-LookbackHasNotes": "encounters",
    "T1-ControllerPrescribed": "drugs",
    "T1-SABAOveruse": "drugs",
    "T1-ExacerbationsCount": "encounters",
  };
  const srcTable = STRUCTURED_SOURCED[args.question_id];
  let upgradeOmopTable: string | null = null;
  if (srcTable && coerced !== null) {
    const hasOmop = (args.evidence ?? []).some((e) => (e as { source?: string }).source === "omop");
    if (!hasOmop) {
      try {
        const s = readStructured(session.patientId) as unknown as Record<string, unknown[]>;
        if (Array.isArray(s[srcTable]) && s[srcTable].length > 0) upgradeOmopTable = srcTable;
      } catch { /* table unreadable → no upgrade, leave the agent's evidence as-is */ }
    }
  }

  // Faithfulness gate on every NOTE evidence quote — same contract the
  // phenotype set_field_assessment uses (CLAUDE.md gotcha #3). A genuinely
  // absent quote rejects the write; a real quote at wrong offsets is
  // accepted with corrected offsets written back. OMOP evidence is recorded
  // as-is (verifyEvidence skips it — only note quotes are byte-checked).
  const evidenceCheck = verifyAnswerEvidence(session.patientId, args.evidence ?? []);
  if (!evidenceCheck.ok) {
    return err(evidenceCheck.error, {
      error_code: "faithfulness_failed",
      hint: "Evidence quote was not found in the note. Call find_quote_offsets (or read_note) to confirm the exact text, then retry set_question_answer with the verbatim quote.",
    });
  }
  const verifiedEvidence = evidenceCheck.verified;

  // Upgrade: attach OMOP provenance for a structured-sourced answer the agent
  // didn't already cite from a row. Table-level (the row the agent used isn't
  // known here, but the source table is deterministic per question).
  if (upgradeOmopTable && !verifiedEvidence.some((e) => (e as { source?: string }).source === "omop")) {
    verifiedEvidence.push({ source: "omop", table: upgradeOmopTable });
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
    evidence: verifiedEvidence.length > 0 ? verifiedEvidence : undefined,
    reasoning: args.reasoning,
    // Verifier DEFERRED for the MVP — no OMOP cross-check.
    verifier_status: "no_check",
    source: "agent",
    ts: new Date().toISOString(),
  };
  if (idx >= 0) list[idx] = next; else list.push(next);
  state.question_answers = list;
  state.version += 1;
  state.updated_at = new Date().toISOString();
  state.updated_by = "agent";
  writeReviewState(session.patientId, session.task.task_id, state);

  return ok({
    question_id: args.question_id,
    version: state.version,
    answer: coerced,
    verifier_status: "no_check",
    answered_count: list.length,
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

// ── set_event_answer ──────────────────────────────────────────────────
// Event-level commit (spec 2026-08-24). The run seeds ETL-enumerated
// RuleEvent stubs into review_state before the agent starts; the agent
// upserts answers per event_id, and may supplement note-origin events
// via new_event. Verdicts are NOT written here — the engine pass after
// the agent loop computes them.

const eventAnswerSchema = z.object({
  question_id: z.string(),
  answer: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(evidenceSchema).optional(),
  reasoning: z.string().optional(),
});

export const setEventAnswerArgsSchema = z.object({
  event_id: z.string().optional(),
  evaluable: z.boolean().optional(),
  evaluable_reason: z.string().optional(),
  answers: z.array(eventAnswerSchema).default([]),
  new_event: z.object({
    rule_id: z.string(),
    anchor_type: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
    note_id: z.string(),
  }).optional(),
});
export type SetEventAnswerArgs = z.infer<typeof setEventAnswerArgsSchema>;

export async function setEventAnswer(
  session: AdherenceMcpSession,
  args: SetEventAnswerArgs,
): Promise<CallToolResult> {
  let skill: AdherenceSkill;
  try { skill = getSkill(session.task.task_id); }
  catch (e) { return err(`failed to load skill: ${(e as Error).message}`); }

  if (args.evaluable === false && !args.evaluable_reason) {
    return err("evaluable:false requires evaluable_reason");
  }

  const state = loadOrCreate(session.patientId, session.task);
  state.task_kind = "adherence";
  const events = state.rule_events ?? [];

  let idx = -1;
  let eventId = args.event_id;
  if (args.new_event) {
    const ne = args.new_event;
    // Reject unknown rule_ids — otherwise the event becomes an orphan the
    // engine passes through unevaluated (Task 2 review erratum).
    if (!skill.rules.some((r) => r.rule_id === ne.rule_id)) {
      return err(`unknown rule_id '${ne.rule_id}'`);
    }
    eventId = `${ne.rule_id}@${ne.date}@note:${ne.note_id}`;
    idx = events.findIndex((e) => e.event_id === eventId);
    if (idx < 0) {
      events.push({
        event_id: eventId,
        rule_id: ne.rule_id,
        anchor: { type: ne.anchor_type, date: ne.date, origin: "note", ref: `note:${ne.note_id}` },
      });
      idx = events.length - 1;
    }
  } else {
    if (!eventId) return err("pass event_id (from the event work-list) or new_event");
    idx = events.findIndex((e) => e.event_id === eventId);
    if (idx < 0) {
      return err(`unknown event_id '${eventId}'`, {
        hint: "Use an event_id from the event work-list in your instructions, or new_event to add a note-documented event.",
      });
    }
  }

  // Coerce + faithfulness-check each event answer against its question def.
  // Dedupe duplicate question_ids WITHIN this call's answers array — last
  // wins — before merging onto the event's existing answers.
  const storedByQuestion = new Map<string, QuestionAnswer>();
  for (const a of args.answers) {
    const q = findQuestion(skill, a.question_id);
    if (!q) return err(`question_id '${a.question_id}' not found`);
    const check = verifyAnswerEvidence(session.patientId, a.evidence ?? []);
    if (!check.ok) {
      return err(`answer '${a.question_id}': ${check.error}`, {
        error_code: "faithfulness_failed",
        hint: "Evidence quote was not found in the note. Call find_quote_offsets (or read_note) to confirm the exact text, then retry.",
      });
    }
    storedByQuestion.set(a.question_id, {
      question_id: a.question_id,
      tier: q.tier,
      answer: coerce(a.answer, q),
      confidence: a.confidence,
      evidence: check.verified.length > 0 ? check.verified : undefined,
      reasoning: a.reasoning,
      verifier_status: "no_check",
      source: "agent",
      ts: new Date().toISOString(),
    });
  }
  const stored = [...storedByQuestion.values()];

  const prev = events[idx];
  const prevAnswers = prev.answers ?? [];
  const merged = [...prevAnswers.filter((p) => !stored.some((s) => s.question_id === p.question_id)), ...stored];
  // Explicit flip back to evaluable:true clears any stale evaluable_reason;
  // otherwise inherit the prior reason unless a new one was passed.
  const evaluableReason =
    args.evaluable === true ? undefined : (args.evaluable_reason ?? prev.evaluable_reason);
  events[idx] = {
    ...prev,
    evaluable: args.evaluable ?? prev.evaluable,
    evaluable_reason: evaluableReason,
    answers: merged.length > 0 ? merged : prev.answers,
    source: "agent",
    ts: new Date().toISOString(),
  };
  state.rule_events = events;
  state.version += 1;
  state.updated_at = new Date().toISOString();
  state.updated_by = "agent";
  writeReviewState(session.patientId, session.task.task_id, state);

  return ok({
    event_id: eventId,
    version: state.version,
    committed_events: events.length,
    answers: stored.map((s) => ({ question_id: s.question_id, answer: s.answer })),
  });
}

// ── get_event_state ───────────────────────────────────────────────────

export async function getEventState(
  session: AdherenceMcpSession,
): Promise<CallToolResult> {
  const state = loadOrCreate(session.patientId, session.task);
  const events = state.rule_events ?? [];
  return ok({
    count: events.length,
    events: events.map((e) => ({
      event_id: e.event_id,
      rule_id: e.rule_id,
      anchor: e.anchor,
      evaluable: e.evaluable,
      answered: (e.answers ?? []).length,
      answered_questions: (e.answers ?? []).map((a) => a.question_id),
    })),
  });
}
