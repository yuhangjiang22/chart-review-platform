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
import { readStructured, readAnchors } from "@chart-review/patients";
import {
  loadAdherenceSkill,
  type AdherenceSkill,
  type QuestionDefinition,
} from "@chart-review/pipeline-extract-adherence";
import {
  compileRule, deriveWorstControlLevel, type RuleDefinition,
} from "@chart-review/rule-engine";

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
      event_scoped?: boolean;
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
          // True → this question describes ONE EVENT, not the window. Commit it
          // through set_event_answer, once per event; set_question_answer
          // rejects it.
          ...(q.event_scoped ? { event_scoped: true } : {}),
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
  // An event-scoped question describes ONE event, so a single period-level
  // answer to it is meaningless — and worse than meaningless: the engine no
  // longer inherits it into events, so nothing reads it, while the reviewer's
  // Questions pane would show it next to the real per-event answers with
  // nothing to say which governs. Rejected rather than stored dead.
  if (q.event_scoped) {
    return err(
      `question_id '${args.question_id}' is answered PER EVENT, not for the period`,
      {
        hint: "Commit it through set_event_answer for each event in the EVENT "
          + "WORK-LIST that names it. The period-level value is derived from "
          + "those events, never extracted separately.",
      },
    );
  }

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
  // ANCHOR FLOOR (BLOCKING, and deliberately so — see the note below on why this
  // one blocks where the provenance gate above does not).
  //
  // A count the ETL derives deterministically is a FLOOR the answer may exceed
  // but not fall below. The ETL cannot see everything — 85% of asthma ED visits
  // carry no OCS row because ED-administered steroids never reach
  // drug_exposure, and a burst can be documented only in a telephone note — so
  // the agent reading notes is real value and must be able to add to the count.
  // What it must not do is contradict what the structured data proves.
  //
  // Caught on a live run: the agent answered T1-ExacerbationsCount = 2 with the
  // reasoning "March 2025 OCS burst and the 2025-11-15 ED/OCS episode", but the
  // March burst fell 33 days BEFORE the 12-month window opened. The anchor list
  // said 1. Nothing compared them, the count crossed the >= 2 persistent-asthma
  // threshold, and a human validated it. The rubric's own retrieval hint tells
  // the agent to "PREFER THE PRECOMPUTED COUNT" from a structured row that this
  // corpus does not contain, so it fell through to counting dates by hand every
  // time.
  //
  // Blocking is safe here in a way the OMOP-provenance reject was not: that gate
  // demanded something the agent often could not supply, so it retried and then
  // nulled the answer to escape. This one names the exact dates and says what to
  // do, and nulling is refused too when the structured data proves an event.
  const ANCHOR_FLOOR: Record<string, string> = {
    "T1-ExacerbationsCount": "exacerbations",
  };
  const floorList = ANCHOR_FLOOR[args.question_id];
  if (floorList) {
    let anchors: Array<{ date?: string }> = [];
    try {
      anchors = ((readAnchors(session.patientId)[floorList] ?? []) as Array<{ date?: string }>);
    } catch { /* no anchors on disk → no floor to enforce */ }
    const floor = anchors.length;
    const dates = anchors.map((a) => a.date).filter(Boolean).join(", ");
    const committed = typeof coerced === "number" ? coerced : null;
    if (floor > 0 && coerced === null) {
      return err(
        `the structured data documents ${floor} ${floorList} in the window (${dates}), `
        + "so this cannot be answered null",
        { error_code: "below_anchor_floor", anchor_count: floor, anchor_dates: dates },
      );
    }
    if (committed !== null && committed < floor) {
      return err(
        `${committed} is below what the structured data proves: ${floor} ${floorList} `
        + `in the window (${dates}). Re-count, or raise the answer to at least ${floor}.`,
        { error_code: "below_anchor_floor", anchor_count: floor, anchor_dates: dates },
      );
    }
    if (committed !== null && committed > floor) {
      // Every event beyond the structured ones has to come from the notes. An
      // OMOP row cannot justify the excess: if it qualified and fell inside the
      // window, the ETL would already have counted it — so an extra backed only
      // by OMOP evidence means a row that is out of window or does not qualify,
      // which is exactly the error this catches.
      const hasNote = (args.evidence ?? []).some(
        (e) => ((e as { source?: string }).source ?? "note") === "note",
      );
      if (!hasNote) {
        return err(
          `${committed} exceeds the ${floor} ${floorList} in the structured data (${dates}), `
          + "so the extra one(s) must be documented in the NOTES — cite the note text for each. "
          + "An OMOP row cannot justify the excess: a qualifying in-window row would already "
          + "be counted, so one that is not counted is out of window or does not qualify.",
          { error_code: "unsupported_excess", anchor_count: floor, anchor_dates: dates },
        );
      }
    }
  }

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

  // "NOT INDICATED" IS AN APPLICABILITY CLAIM, AND IT IS CHECKABLE.
  //
  // R-T2-SpecialtyReferralWhenIndicated takes applicability from this answer
  // alone (`excluded_if: T2-SpecialtyReferral == "not_indicated"`), while its
  // description defines indication as "not well controlled OR Step 4+". So a
  // single word from the extractor drops the patient out of the denominator and
  // nothing objects — including for a patient whose own per-event control levels
  // make them very_poorly_controlled. The bias runs UPWARD (a missed care gap),
  // opposite to most of what this audit found.
  //
  // Checked rather than re-gated (study lead, 2026-08-28): the Step 4+ arm has no
  // patient-level derived value, so moving applicability into the rule would
  // narrow the requirement. This leaves the judgment with the extractor and
  // refuses only the flat contradiction — the control level says indicated, the
  // answer says not indicated.
  //
  // Silent when the control level is not yet establishable (no event carries one
  // — the agent may answer this before working the event list). That ordering
  // gap is why the batch runner ALSO warns after its final pass, when every
  // event is in.
  if (args.question_id === "T2-SpecialtyReferral" && coerced === "not_indicated") {
    const worst = deriveWorstControlLevel(state.rule_events ?? []);
    if (worst && worst !== "well_controlled" && worst !== "undetermined") {
      return err(
        `this patient's own per-event control levels make them ${worst}, so specialty `
        + "referral IS indicated — \"not_indicated\" only applies to a patient who is well "
        + "controlled at every visit AND below Step 4. Answer \"not_referred\" if no "
        + "referral is documented.",
        { error_code: "contradicts_control_level", worst_control_level: worst },
      );
    }
  }

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

/** question_ids a rule legitimately reads — its own expressions plus the
 *  questions it declares as supporting context. Used to reject an answer
 *  aimed at some other event's rule. Deliberately permissive: it accepts
 *  anything the rule references or declares, and only rejects a question with
 *  no relationship to it at all. */
function eventQuestionScope(rule: RuleDefinition): Set<string> {
  const out = new Set<string>(compileRule(rule).qids);
  if (rule.event_evaluable_if) {
    for (const q of compileRule({ ...rule, verdict_if: rule.event_evaluable_if }).qids) out.add(q);
  }
  for (const q of rule.supporting_questions ?? []) out.add(q);
  return out;
}

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

  const eventRule = skill.rules.find((r) => r.rule_id === events[idx]!.rule_id);

  // Coerce + faithfulness-check each event answer against its question def.
  // Dedupe duplicate question_ids WITHIN this call's answers array — last
  // wins — before merging onto the event's existing answers.
  const storedByQuestion = new Map<string, QuestionAnswer>();
  for (const a of args.answers) {
    const q = findQuestion(skill, a.question_id);
    if (!q) return err(`question_id '${a.question_id}' not found`);
    // Reject a question that belongs to a DIFFERENT event's rule. Observed on
    // a live run: the agent committed T2-FollowupScheduled onto a
    // step-therapy event, which stored fine and then contributed nothing —
    // the step rule's own question stayed missing, so that event silently
    // dropped out of the denominator while looking answered.
    if (eventRule && !eventQuestionScope(eventRule).has(a.question_id)) {
      return err(
        `question_id '${a.question_id}' is not in scope for rule '${eventRule.rule_id}'`,
        {
          hint: `This event's rule reads: ${[...eventQuestionScope(eventRule)].sort().join(", ")}. `
            + "Check the event work-list line for the question_ids this event needs.",
        },
      );
    }
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
