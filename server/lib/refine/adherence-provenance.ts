// refine/adherence-provenance.ts — apply + provenance + revert for adherence
// question refinements. The friction vs phenotype: a question is NOT its own
// file — it's one entry in a tier YAML bundle
// (references/questions/T<N>_*.yaml, top-level `questions: [...]`). So apply
// locates the bundle holding the question_id, appends the addition to THAT
// question's retrieval_hints (leaving sibling questions intact), and writes the
// bundle back. Prior text is snapshotted for revert. Log:
// <skill>/adherence_refinement_log.jsonl.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { guidelineDir, resolveRubricRoot } from "@chart-review/rubric";
import { atomicWriteText } from "../criterion-md.js";

// ── Shapes ─────────────────────────────────────────────────────────────────────

export interface AdherenceCardSnapshot {
  examples: Array<{ patient_id: string; agent_answer: unknown; reviewer_answer: unknown; excerpt?: string | null }>;
  gap_summary: string;
  rationale: string;
  classification_hint?: string;
}

export interface AdherenceLogEntry {
  entry_id: string;
  task_id: string;
  question_id: string;
  /** Bundle file (relative to references/questions) the question lives in. */
  question_file: string;
  iter_id?: string;
  session_id?: string;
  applied_at: string;
  applied_by: string;
  proposed_hint_addition: string;
  prior_retrieval_hints: string;
  new_retrieval_hints: string;
  card?: AdherenceCardSnapshot;
  reverted?: { at: string; by: string; intervening_edit: boolean };
}

interface QuestionsDoc {
  questions?: Array<Record<string, unknown>>;
}

// ── Bundle location ────────────────────────────────────────────────────────────

// The question bundles live on whichever rubric root the (task, session)
// resolves to — the session fork when one exists (so a refinement edits THAT
// session's rubric, not the shared baseline), else the baseline. Mirrors the
// phenotype criterion-md path. Inside a run subprocess, resolveRubricRoot honors
// CHART_REVIEW_RUBRIC_ROOT first, so no sessionId is needed there.
function questionsDir(taskId: string, sessionId?: string): string {
  return path.join(resolveRubricRoot(taskId, sessionId), "references", "questions");
}

/** Find the tier bundle file + the question object that holds question_id. */
export function findQuestionInBundles(
  taskId: string,
  questionId: string,
  sessionId?: string,
): { file: string; doc: QuestionsDoc; question: Record<string, unknown> } | null {
  const dir = questionsDir(taskId, sessionId);
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const fp = path.join(dir, f);
    let doc: QuestionsDoc;
    try {
      doc = (parseYaml(fs.readFileSync(fp, "utf8")) ?? {}) as QuestionsDoc;
    } catch {
      continue;
    }
    const q = (doc.questions ?? []).find((x) => x && (x as { question_id?: unknown }).question_id === questionId);
    if (q) return { file: f, doc, question: q as Record<string, unknown> };
  }
  return null;
}

/** Direct (human) edit of a question's editable fields in its tier bundle —
 *  the AUTHOR-pane counterpart to the refinement Apply. Sets (not appends)
 *  `text` / `retrieval_hints`; sibling questions are untouched. Not logged to
 *  the refinement provenance (that log is for agent-proposed applies only),
 *  matching the phenotype PUT /criteria behavior. */
export function setAdherenceQuestionFields(
  taskId: string,
  questionId: string,
  fields: { text?: string; retrieval_hints?: string },
  sessionId?: string,
): void {
  const found = findQuestionInBundles(taskId, questionId, sessionId);
  if (!found) throw new Error(`question ${questionId} not found in ${taskId} question bundles`);
  if (typeof fields.text === "string") found.question.text = fields.text;
  if (typeof fields.retrieval_hints === "string") found.question.retrieval_hints = fields.retrieval_hints;
  atomicWriteText(path.join(questionsDir(taskId, sessionId), found.file), stringifyYaml(found.doc));
}

// ── Log IO ─────────────────────────────────────────────────────────────────────

function logPath(taskId: string): string {
  return path.join(guidelineDir(taskId), "adherence_refinement_log.jsonl");
}
function readAll(taskId: string): AdherenceLogEntry[] {
  try {
    const out: AdherenceLogEntry[] = [];
    for (const line of fs.readFileSync(logPath(taskId), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as AdherenceLogEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}
function writeAll(taskId: string, entries: AdherenceLogEntry[]): void {
  atomicWriteText(logPath(taskId), entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
}

/** Refinement log for an adherence task, newest-first, optionally per question. */
export function readAdherenceRefinementLog(taskId: string, questionId?: string): AdherenceLogEntry[] {
  const all = readAll(taskId);
  return (questionId ? all.filter((e) => e.question_id === questionId) : all).slice().reverse();
}

// ── Apply ──────────────────────────────────────────────────────────────────────

function getHints(q: Record<string, unknown>): string {
  return typeof q.retrieval_hints === "string" ? q.retrieval_hints : "";
}

export interface ApplyAdherenceInput {
  taskId: string;
  questionId: string;
  hintAddition: string;
  card?: AdherenceCardSnapshot;
  appliedBy: string;
  iterId?: string;
  sessionId?: string;
  now?: string;
  entryId?: string;
}

/**
 * Append `hintAddition` to the question's retrieval_hints inside its tier bundle
 * and log the edit. Sibling questions in the bundle are untouched (we mutate one
 * object's field and re-stringify the whole doc — content-preserving).
 */
export function applyAdherenceRefinement(input: ApplyAdherenceInput): AdherenceLogEntry {
  const add = input.hintAddition.trim();
  if (!add) throw new Error("hintAddition is empty");

  const found = findQuestionInBundles(input.taskId, input.questionId, input.sessionId);
  if (!found) throw new Error(`question ${input.questionId} not found in ${input.taskId} question bundles`);

  const priorRaw = getHints(found.question); // untrimmed snapshot, for exact revert
  const prior = priorRaw.trim();

  // Idempotency: if this exact addition is already in the hints, re-applying
  // would duplicate it. No-op — don't append, don't re-log. Return the existing
  // non-reverted log entry for this question if present, else a no-op entry.
  if (prior.includes(add)) {
    const existing = readAll(input.taskId).find(
      (e) => e.question_id === input.questionId && e.session_id === input.sessionId &&
        !e.reverted && e.proposed_hint_addition.trim() === add,
    );
    const now0 = input.now ?? new Date().toISOString();
    return existing ?? {
      entry_id: input.entryId ?? `${now0}-${input.questionId}`,
      task_id: input.taskId, question_id: input.questionId, question_file: found.file,
      iter_id: input.iterId, session_id: input.sessionId, applied_at: now0,
      applied_by: input.appliedBy, proposed_hint_addition: add,
      prior_retrieval_hints: priorRaw, new_retrieval_hints: priorRaw, card: input.card,
    };
  }

  const next = prior ? `${prior}\n${add}` : add;
  found.question.retrieval_hints = next;

  atomicWriteText(path.join(questionsDir(input.taskId, input.sessionId), found.file), stringifyYaml(found.doc));

  const now = input.now ?? new Date().toISOString();
  const entry: AdherenceLogEntry = {
    entry_id: input.entryId ?? `${now}-${input.questionId}`,
    task_id: input.taskId,
    question_id: input.questionId,
    question_file: found.file,
    iter_id: input.iterId,
    session_id: input.sessionId,
    applied_at: now,
    applied_by: input.appliedBy,
    proposed_hint_addition: add,
    prior_retrieval_hints: priorRaw,
    new_retrieval_hints: next,
    card: input.card,
  };
  writeAll(input.taskId, [...readAll(input.taskId), entry]);
  return entry;
}

// ── Revert ───────────────────────────────────────────────────────────────────

export interface AdherenceRevertResult {
  entry: AdherenceLogEntry;
  intervening_edit: boolean;
}

export function revertAdherenceRefinement(opts: {
  taskId: string;
  entryId: string;
  by: string;
  now?: string;
}): AdherenceRevertResult {
  const all = readAll(opts.taskId);
  const idx = all.findIndex((e) => e.entry_id === opts.entryId);
  if (idx < 0) throw new Error(`adherence refinement log entry ${opts.entryId} not found`);
  const entry = all[idx];
  if (entry.reverted) throw new Error(`entry ${opts.entryId} is already reverted`);

  // The edit landed on the entry's session fork (or baseline) — restore THERE.
  const found = findQuestionInBundles(opts.taskId, entry.question_id, entry.session_id);
  if (!found) throw new Error(`question ${entry.question_id} not found for revert`);

  const intervening_edit = getHints(found.question).trim() !== entry.new_retrieval_hints.trim();
  found.question.retrieval_hints = entry.prior_retrieval_hints;
  atomicWriteText(path.join(questionsDir(opts.taskId, entry.session_id), found.file), stringifyYaml(found.doc));

  const now = opts.now ?? new Date().toISOString();
  all[idx] = { ...entry, reverted: { at: now, by: opts.by, intervening_edit } };
  writeAll(opts.taskId, all);
  return { entry: all[idx], intervening_edit };
}
