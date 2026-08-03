// refine/provenance.ts — Task S4 of the self-refinement increment.
//
// Closes the human-applied loop with PROVENANCE. When a reviewer clicks Apply on
// a proposal card, the rule is appended to the criterion's extraction guidance
// AND a record is written to `<skill>/refinement_log.jsonl` capturing the whole
// card (① wrong examples, ② gap, ③ rule, ④ held-out Δ), the prior criterion
// text (so the edit is revertable), and who/when. The criterion's history then
// shows "this rule was added to fix these N cases (+Δ)", and any applied edit
// can be reverted.
//
// Edits go through the SAME canonical reader/writer the rubric editor uses
// (criterion-md.ts) so the .md format stays identical.

import fs from "node:fs";
import path from "node:path";
import { phenotypeSkillDir } from "@chart-review/rubric";
import {
  criterionMdPath,
  parseCriterionMd,
  buildCriterionMd,
  atomicWriteText,
} from "../criterion-md.js";

// ── Shapes ─────────────────────────────────────────────────────────────────────

/** A trimmed snapshot of the proposal card, stored as the edit's reason. */
export interface RefinementCardSnapshot {
  examples: Array<{
    patient_id: string;
    agent_answer: unknown;
    reviewer_answer: unknown;
    classification_hint: string;
    excerpt?: string | null;
  }>;
  gap_summary: string;
  rationale: string;
  /** ④ — the held-out result object as returned by /propose (delta/n_fixed/…
   *  or { insufficient_holdout }). Stored verbatim for the history view. */
  holdout?: unknown;
  refine_n?: number;
}

export interface RefinementLogEntry {
  entry_id: string;
  task_id: string;
  field_id: string;
  iter_id?: string;
  session_id?: string;
  applied_at: string;
  applied_by: string;
  /** ③ — the rule appended to the criterion. */
  proposed_rule_text: string;
  /** Snapshot of the criterion's extraction guidance BEFORE the append, so the
   *  edit is revertable. */
  prior_extraction_guidance: string;
  /** The extraction guidance AFTER the append (to detect intervening edits on
   *  revert). */
  new_extraction_guidance: string;
  card?: RefinementCardSnapshot;
  /** Set once this edit has been reverted. */
  reverted?: { at: string; by: string; intervening_edit: boolean };
}

// ── Log IO ───────────────────────────────────────────────────────────────────

function refinementLogPath(taskId: string): string {
  return path.join(phenotypeSkillDir(taskId), "refinement_log.jsonl");
}

/** Read all log entries (file order). Returns [] when the log doesn't exist. */
function readAll(taskId: string): RefinementLogEntry[] {
  try {
    const raw = fs.readFileSync(refinementLogPath(taskId), "utf8");
    const out: RefinementLogEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as RefinementLogEntry);
      } catch {
        /* skip a corrupt line rather than failing the whole read */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(taskId: string, entries: RefinementLogEntry[]): void {
  atomicWriteText(
    refinementLogPath(taskId),
    entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""),
  );
}

/**
 * Read the refinement log, newest-first. Optionally filter to one field. Each
 * entry is the provenance for one applied (or applied-then-reverted) edit.
 */
export function readRefinementLog(
  taskId: string,
  fieldId?: string,
  sessionId?: string,
): RefinementLogEntry[] {
  const all = readAll(taskId);
  let filtered = fieldId ? all.filter((e) => e.field_id === fieldId) : all;
  // The log is task-level (one file), but each entry records the session that
  // made it. When a sessionId is given, show only THAT session's refinements —
  // so a session's history reflects its own inner loop, not every session's.
  if (sessionId) filtered = filtered.filter((e) => e.session_id === sessionId);
  return filtered.slice().reverse(); // newest-first
}

// ── Apply ──────────────────────────────────────────────────────────────────────

export interface ApplyRefinementInput {
  taskId: string;
  fieldId: string;
  /** ③ — the rule to append (already bullet-stripped by the caller). */
  ruleText: string;
  card?: RefinementCardSnapshot;
  appliedBy: string;
  iterId?: string;
  sessionId?: string;
  /** Injected for determinism in tests; default new Date().toISOString(). */
  now?: string;
  /** Injected for determinism in tests; default a time-based id. */
  entryId?: string;
}

/**
 * Append `ruleText` to the criterion's extraction guidance and record the edit
 * in the refinement log. Returns the new log entry. Throws on a missing
 * criterion / unsafe id / empty rule.
 */
export function applyRefinement(input: ApplyRefinementInput): RefinementLogEntry {
  const rule = input.ruleText.trim();
  if (!rule) throw new Error("ruleText is empty");

  const mdPath = criterionMdPath(input.taskId, input.fieldId, input.sessionId);
  if (!fs.existsSync(mdPath)) {
    throw new Error(`criterion ${input.fieldId} not found for task ${input.taskId}`);
  }

  const parsed = parseCriterionMd(fs.readFileSync(mdPath, "utf8"));
  const fm = parsed.frontmatter;
  const prior = parsed.extraction_guidance.trim();

  // Idempotency: if this exact rule is already in the guidance, re-applying would
  // duplicate the paragraph. No-op — don't append, don't re-log. Return the
  // existing non-reverted log entry for this field if present, else a no-op entry
  // reflecting the unchanged guidance. Makes a double-apply harmless regardless
  // of the UI.
  if (prior.includes(`- ${rule}`)) {
    const existing = readAll(input.taskId).find(
      (e) => e.field_id === input.fieldId && e.session_id === input.sessionId &&
        !e.reverted && e.proposed_rule_text.trim() === rule,
    );
    const now0 = input.now ?? new Date().toISOString();
    return existing ?? {
      entry_id: input.entryId ?? `${now0}-${input.fieldId}`,
      task_id: input.taskId, field_id: input.fieldId, iter_id: input.iterId,
      session_id: input.sessionId, applied_at: now0, applied_by: input.appliedBy,
      proposed_rule_text: rule, prior_extraction_guidance: parsed.extraction_guidance,
      new_extraction_guidance: parsed.extraction_guidance, card: input.card,
    };
  }

  const next = prior ? `${prior}\n\n- ${rule}` : `- ${rule}`;

  const schema = fm.answer_schema as { enum?: string[] } | undefined;
  const enumValues: string[] = Array.isArray(schema?.enum) ? (schema!.enum as string[]) : [];

  const newMd = buildCriterionMd({
    field_id: input.fieldId,
    prompt: typeof fm.prompt === "string" ? fm.prompt : "",
    enumValues,
    cardinality: typeof fm.cardinality === "string" ? fm.cardinality : "one",
    group: typeof fm.group === "string" ? fm.group : "",
    definition: parsed.definition,
    extraction_guidance: next,
    examples: parsed.examples,
  });
  atomicWriteText(mdPath, newMd);

  const now = input.now ?? new Date().toISOString();
  const entry: RefinementLogEntry = {
    entry_id: input.entryId ?? `${now}-${input.fieldId}`,
    task_id: input.taskId,
    field_id: input.fieldId,
    iter_id: input.iterId,
    session_id: input.sessionId,
    applied_at: now,
    applied_by: input.appliedBy,
    proposed_rule_text: rule,
    prior_extraction_guidance: parsed.extraction_guidance,
    new_extraction_guidance: next,
    card: input.card,
  };
  writeAll(input.taskId, [...readAll(input.taskId), entry]);
  return entry;
}

// ── Revert ───────────────────────────────────────────────────────────────────

export interface RevertResult {
  entry: RefinementLogEntry;
  /** True when the criterion's guidance had been edited since the apply, so the
   *  revert restored the pre-apply snapshot over those later changes. */
  intervening_edit: boolean;
}

/**
 * Revert a previously-applied edit: restore the criterion's extraction guidance
 * to the entry's pre-apply snapshot and mark the entry reverted. If the guidance
 * was edited since (no longer matches the recorded post-apply text), the revert
 * still restores the snapshot but flags `intervening_edit` so the caller can
 * warn. Throws on unknown / already-reverted entry.
 */
export function revertRefinement(opts: {
  taskId: string;
  entryId: string;
  by: string;
  now?: string;
}): RevertResult {
  const all = readAll(opts.taskId);
  const idx = all.findIndex((e) => e.entry_id === opts.entryId);
  if (idx < 0) throw new Error(`refinement log entry ${opts.entryId} not found`);
  const entry = all[idx];
  if (entry.reverted) throw new Error(`entry ${opts.entryId} is already reverted`);

  const mdPath = criterionMdPath(opts.taskId, entry.field_id, entry.session_id);
  if (!fs.existsSync(mdPath)) {
    throw new Error(`criterion ${entry.field_id} not found for task ${opts.taskId}`);
  }
  const parsed = parseCriterionMd(fs.readFileSync(mdPath, "utf8"));
  const intervening_edit =
    parsed.extraction_guidance.trim() !== entry.new_extraction_guidance.trim();

  const fm = parsed.frontmatter;
  const schema = fm.answer_schema as { enum?: string[] } | undefined;
  const enumValues: string[] = Array.isArray(schema?.enum) ? (schema!.enum as string[]) : [];
  const newMd = buildCriterionMd({
    field_id: entry.field_id,
    prompt: typeof fm.prompt === "string" ? fm.prompt : "",
    enumValues,
    cardinality: typeof fm.cardinality === "string" ? fm.cardinality : "one",
    group: typeof fm.group === "string" ? fm.group : "",
    definition: parsed.definition,
    extraction_guidance: entry.prior_extraction_guidance,
    examples: parsed.examples,
  });
  atomicWriteText(mdPath, newMd);

  const now = opts.now ?? new Date().toISOString();
  all[idx] = { ...entry, reverted: { at: now, by: opts.by, intervening_edit } };
  writeAll(opts.taskId, all);
  return { entry: all[idx], intervening_edit };
}
