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

const evidenceSchema = z.object({
  note_id: z.string(),
  quote: z.string(),
  // `.nullish()`: agents pass explicit null for offsets they didn't compute.
  start: z.number().int().nonnegative().nullish(),
  end: z.number().int().nonnegative().nullish(),
});

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

  // Faithfulness gate on every NOTE evidence quote — same contract the
  // phenotype set_field_assessment uses (CLAUDE.md gotcha #3). A genuinely
  // absent quote rejects the write; a real quote at wrong offsets is
  // accepted with corrected offsets written back.
  const evidence = args.evidence ?? [];
  const verifiedEvidence: NonNullable<QuestionAnswer["evidence"]> = [];
  for (const ev of evidence) {
    const start = ev.start ?? 0;
    const end = ev.end ?? (start + (ev.quote?.length ?? 0));
    const result = verifyEvidence(session.patientId, {
      source: "note",
      note_id: ev.note_id,
      span_offsets: [start, end],
      verbatim_quote: ev.quote,
    });
    if (result.status === "fail") {
      return err(
        `faithfulness check failed for evidence in note '${ev.note_id}': ${result.detail ?? "quote not found"}`,
        {
          error_code: "faithfulness_failed",
          hint: "Evidence quote was not found in the note. Call find_quote_offsets (or read_note) to confirm the exact text, then retry set_question_answer with the verbatim quote.",
        },
      );
    }
    const [cs, ce] = result.corrected_offsets ?? [start, end];
    verifiedEvidence.push({ note_id: ev.note_id, quote: ev.quote, start: cs, end: ce });
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
