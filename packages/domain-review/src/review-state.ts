/**
 * Filesystem-backed mutable review state, one file per patient×task.
 * Path: <PLATFORM_ROOT>/reviews/<patient_id>/<task_id>/review_state.json.
 *
 * Atomic writes via writeJsonAtomic. Optimistic concurrency on `version`.
 * Both the chat agent (via the in-process MCP `set_field_assessment`
 * tool) and the reviewer (via the UI's PATCH endpoint) write here.
 *
 * ── Structure (Phase R3 refactor) ────────────────────────────────────────
 *
 *   applyUiAction(...) is a thin orchestrator that:
 *     1. verifyFaithfulnessForAction(...)   — gate; throws on fabrication
 *     2. transitionReviewState(...)         — PURE: (state,action) → newState
 *     3. recomputeAlerts(...)               — derived: cross-criterion alerts
 *     4. writeReviewState(...)              — disk write (writeJsonAtomic)
 *     5. checkDriftAfterAction(...)         — best-effort; logs and continues
 *     6. maybeFireAutoRoleC(...)            — best-effort; fire-and-forget
 *
 *   The pure core has NO I/O, NO audit append, NO alert recompute. It's
 *   trivially unit-testable: synthesise a state, call it, assert on the
 *   returned newState. Side effects are top-level functions called in
 *   sequence by applyUiAction.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { PLATFORM_ROOT, listNotes, readNote } from "@chart-review/patients";
import { getReviewsRootOverride, withReviewsRoot as _withReviewsRoot } from "@chart-review/reviews-context";
import type { Evidence } from "@chart-review/faithfulness";
import { verifyEvidence } from "@chart-review/faithfulness";
import type { CompiledTask } from "@chart-review/tasks";
import type {
  CrossCriterionAlert, SpanLabel, QuestionAnswer, RuleVerdict,
} from "@chart-review/platform-types";
import { recomputeLiveAlerts } from "@chart-review/live-alerts";
import { evalDerivation } from "@chart-review/contract-eval";
import { checkDrift } from "@chart-review/drift-detector";
import { appendAuditEntry } from "@chart-review/audit-trail";
import { shouldAutoRoleC, fireAutoRoleC } from "@chart-review/auto-role-c";
import { writeJsonAtomic } from "@chart-review/fs-atomic";
import { snapshotCriterionHashesSync, maybeTransitionIterToValidating } from "@chart-review/domain-iter/pilots";

/** Exported for tests that want to know the default value. Not used
 *  internally after the lazy accessor below was introduced. */
export const REVIEWS_ROOT =
  process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");

/** Always re-read the override / env var so test code can change it
 *  without having to reset the module. The override (set by
 *  `withReviewsRoot` in reviews-context.ts) lets the batch-run driver
 *  redirect writes per-async-chain without env-var leaks. */
function reviewsRoot(): string {
  const override = getReviewsRootOverride();
  if (override) return override;
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

/** Re-export so callers can stay decoupled from reviews-context.ts. */
export const withReviewsRoot = _withReviewsRoot;

const SCHEMA_VERSION = "1";

export type AssessmentStatus =
  | "pending"
  | "agent_proposed"
  | "approved"
  | "overridden"
  | "not_applicable";

/**
 * Provenance of a FieldAssessment.
 *
 *   "agent"    — written by an agent run (MCP set_field_assessment).
 *   "reviewer" — written by a human reviewer (HTTP /actions).
 *   "derived"  — auto-computed by the server from a field's derivation
 *                expression. Refreshes on each leaf write. Never overwritten
 *                when a reviewer has manually answered the same derived
 *                field (source === "reviewer").
 */
export type AssessmentSource = "agent" | "reviewer" | "derived";

export type EditReason =
  | "missed_evidence"
  | "misinterpreted"
  | "wrong_rule"
  | "criterion_ambiguous"
  | "other";

export interface OriginalAgentSnapshot {
  answer?: unknown;
  evidence?: Evidence[];
  rationale?: string;
  confidence?: "low" | "medium" | "high";
  captured_at: string;
  captured_from_version: number;
}

export interface FieldAssessment {
  field_id: string;
  answer?: unknown;
  confidence?: "low" | "medium" | "high";
  evidence?: Evidence[];
  rationale?: string;
  source: AssessmentSource;
  status: AssessmentStatus;
  updated_at: string;
  updated_by: string;
  // Phase B additions
  edit_reason?: EditReason;
  edit_note?: string;
  original_agent_snapshot?: OriginalAgentSnapshot;
  /** #45 — when present, this assessment scopes its answer to a specific
   *  encounter or episode (rather than patient-wide). Multiple assessments
   *  for the same field_id can coexist as long as their encounter_id
   *  values differ. The UI groups by encounter for guidelines that opt in
   *  via field.encounter_scoped=true. */
  encounter_id?: string;
  /** Free-text reviewer commentary about this annotation: anything worth
   *  surfacing for guideline iteration that doesn't fit `rationale`.
   *  Fed verbatim to the derived-adjudication classifier and to
   *  chart-review-improve clustering. */
  comment?: string;
  /** SHA of the criterion at the time this assessment was committed.
   *  When this differs from the criterion's current SHA, the record is
   *  stale and surfaces in the revisit list. Optional only for back-compat
   *  with pre-existing records; new records always set it. */
  captured_against_schema_hash?: string;
}

/** #45 — first-class encounter / episode for guidelines that need to capture
 *  per-visit findings (oncology presentations across multiple encounters,
 *  recurrent infections, etc.). The list is editable by the reviewer; each
 *  encounter has a stable id used to scope FieldAssessment.encounter_id. */
export interface Encounter {
  encounter_id: string;
  /** "encounter" = a single visit / contact; "episode" = a span (e.g. an
   *  oncology treatment course). The choice is guideline-driven. */
  kind: "encounter" | "episode";
  /** Optional ISO date — start date for episodes, visit date for encounters. */
  date?: string;
  /** Free-text label the reviewer can edit ("oncology consult 2024-08-22"). */
  label?: string;
  /** note_ids that anchor the encounter, when reviewer wants to bind notes. */
  note_ids?: string[];
}

export interface ReviewSummary {
  brief_summary?: string;
  key_conditions?: string[];
  uncertainties?: string[];
  evidence_files?: string[];
  updated_at?: string;
  updated_by?: string;
}

export interface SelectedEvidence {
  id: string;
  evidence: Evidence;
  rationale?: string;
  category?: "supporting" | "contradicting" | "context";
  field_id?: string;
  added_at: string;
  added_by: string;
}

export interface KeywordSuggestions {
  topic?: string;
  direct_terms?: string[];
  aliases?: string[];
  abbreviations?: string[];
  behavioral_clues?: string[];
  treatment_terms?: string[];
  negation_patterns?: string[];
  updated_at?: string;
  updated_by?: string;
}

export interface ReviewState {
  schema_version: "1";
  patient_id: string;
  task_id: string;
  task_version?: string;
  task_document_sha?: string;
  review_status: "draft" | "in_progress" | "agent_complete" | "reviewer_validated" | "locked";
  version: number;
  updated_at: string;
  updated_by: AssessmentSource | "system";
  field_assessments: FieldAssessment[];
  summary?: ReviewSummary;
  keyword_suggestions?: KeywordSuggestions;
  selected_evidence?: SelectedEvidence[];
  /** Recomputed on every mutation (spec §5.3). */
  cross_criterion_alerts?: CrossCriterionAlert[];
  locked_at?: string;
  locked_by?: string;
  lock_task_sha?: string;
  assigned_to?: string[];
  /** #45 — encounter / episode list. Empty for patient-level guidelines.
   *  When the guideline declares fields with encounter_scoped=true, the UI
   *  iterates this list and shows one row per (encounter, field_id). */
  encounters?: Encounter[];
  /** NER (task_kind="ner") span lists. Lives in the union-shaped
   *  review_state.json alongside field_assessments — phenotype tasks
   *  leave this absent. Reader / writer code paths key on `task_kind`
   *  on the parent CompiledTask, not on this field's presence; absent
   *  span_labels in an NER review means "no spans committed yet". */
  span_labels?: SpanLabel[];
  /** Optional discriminator copy of the task's kind. Persisted by the
   *  task-kind-specific write paths so downstream consumers can identify
   *  the review-state shape without re-loading the task. Optional —
   *  phenotype state files written before this field existed remain valid. */
  task_kind?: "phenotype" | "ner" | "adherence";
  /** NER-only: note IDs (without .txt suffix) the reviewer has marked
   *  as validated for this patient × task. Used for per-note progress
   *  in the SpanReview UI; empty / absent means nothing validated yet.
   *  Maintained via POST /api/reviews/:pid/:tid/notes/:nid/validation. */
  validated_notes?: string[];
  /** Adherence (task_kind="adherence") extractor answers — one per
   *  question in the guideline's question framework. Lives in the
   *  union-shaped review_state.json alongside field_assessments and
   *  span_labels. Phenotype/NER tasks leave this absent. */
  question_answers?: QuestionAnswer[];
  /** Adherence-only: per-rule concordance verdicts (CONCORDANT /
   *  NON_CONCORDANT / EXCLUDED) computed from question_answers by the
   *  rule engine. Empty / absent until the rule-eval pass runs. */
  rule_verdicts?: RuleVerdict[];
  /** Adherence-only: question_ids the reviewer has marked validated.
   *  Drives per-question progress in the AdherenceReview UI; analogous
   *  to validated_notes for NER. */
  validated_questions?: string[];
  /** Adherence-only: rule_ids the reviewer has marked adjudicated. */
  validated_rules?: string[];
  /** Adherence-only: per-agent shadow drafts captured at import time
   *  (key = agent_id, value = that agent's full QuestionAnswer[]).
   *  Read-only — the canonical reviewer-editable answers stay in
   *  `question_answers`. Drives the A/B provenance columns in the
   *  AdherenceReview UI. */
  agent_question_answers?: Record<string, QuestionAnswer[]>;
  /** Adherence-only: per-agent shadow rule verdicts at import time.
   *  Same shape + role as agent_question_answers. */
  agent_rule_verdicts?: Record<string, RuleVerdict[]>;
}

function reviewDir(patientId: string, taskId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(patientId)) {
    throw new Error(`invalid patient_id: ${patientId}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    throw new Error(`invalid task_id: ${taskId}`);
  }
  return path.join(reviewsRoot(), patientId, taskId);
}

function statePath(patientId: string, taskId: string): string {
  return path.join(reviewDir(patientId, taskId), "review_state.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Load existing state, or fabricate an empty one (and persist it).
 * The caller passes the compiled task so we can pre-populate one
 * placeholder assessment per leaf field; derived/gated fields stay
 * out of the assessment list (they're computed, not asserted).
 */
export function loadOrCreate(
  patientId: string,
  task: CompiledTask,
): ReviewState {
  const p = statePath(patientId, task.task_id);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ReviewState;
  }
  fs.mkdirSync(reviewDir(patientId, task.task_id), { recursive: true });
  const initial: ReviewState = {
    schema_version: SCHEMA_VERSION,
    patient_id: patientId,
    task_id: task.task_id,
    task_version: task.manual_version,
    task_document_sha: task.source_document_sha,
    review_status: "draft",
    version: 1,
    updated_at: nowIso(),
    updated_by: "system",
    field_assessments: [],
  };
  writeJsonAtomic(p, initial);
  return initial;
}

/**
 * Persist a ReviewState to disk via the universal atomic-write helper.
 * Caller is responsible for having bumped version / updated_at / updated_by
 * (typically via transitionReviewState) before calling.
 */
export function writeReviewState(patientId: string, taskId: string, state: ReviewState): void {
  fs.mkdirSync(reviewDir(patientId, taskId), { recursive: true });
  writeJsonAtomic(statePath(patientId, taskId), state);
}

/**
 * Apply a function to the current state and persist the result. Throws
 * if `expectedVersion` is provided and does not match (optimistic
 * concurrency). The mutator should NOT touch `version`/`updated_at`/
 * `updated_by` — this helper does that.
 *
 * Used by helper variants (applySetAssessment, applySetSummary, etc.)
 * for paths that don't need the full applyUiAction pipeline. Internally,
 * this is the same shape as transitionReviewState but with the load and
 * write baked in.
 */
export function mutate(
  patientId: string,
  task: CompiledTask,
  by: AssessmentSource | "system",
  mutator: (s: ReviewState) => void,
  expectedVersion?: number,
): ReviewState {
  const current = loadOrCreate(patientId, task);
  // Lock guard — once locked, all writes (agent + reviewer) are rejected.
  // The guard checks PERSISTED state, not the incoming payload, so the write
  // that *transitions into* locked status passes through (state is still
  // "reviewer_validated" at that moment).
  if (current.review_status === "locked") {
    throw new ReviewStateError("RECORD_LOCKED", "Record is locked; no further writes allowed");
  }
  if (expectedVersion !== undefined && expectedVersion !== current.version) {
    throw new Error(
      `version conflict: expected ${expectedVersion}, current ${current.version}`,
    );
  }
  mutator(current);
  // Recompute live alerts after every state mutation (spec §5.3).
  current.cross_criterion_alerts = recomputeLiveAlerts(task, current);
  current.version += 1;
  current.updated_at = nowIso();
  current.updated_by = by;
  writeReviewState(patientId, task.task_id, current);
  return current;
}

export interface PerNoteWriteInput {
  noteId: string;
  date?: string;
  label?: string;
  fields: Array<{
    field_id: string;
    answer?: unknown;
    confidence?: "low" | "medium" | "high";
    evidence?: Evidence[];
    rationale?: string;
  }>;
}

/** Direct (non-MCP) writer for per-note phenotype labels. Upserts one Encounter
 *  per note (keyed by note_id) and one agent FieldAssessment per (field, note).
 *  Runs through `mutate`, so it respects the ambient reviews-root override the
 *  batch runner sets via withReviewsRoot. */
export function writePerNoteAssessments(
  patientId: string,
  task: CompiledTask,
  input: PerNoteWriteInput,
): ReviewState {
  return mutate(patientId, task, "agent", (s) => {
    s.task_kind = "phenotype";
    if (!s.encounters) s.encounters = [];
    if (!s.encounters.some((e) => e.encounter_id === input.noteId)) {
      s.encounters.push({
        encounter_id: input.noteId,
        kind: "encounter",
        date: input.date,
        label: input.label,
        note_ids: [input.noteId],
      });
    }
    const now = new Date().toISOString();
    for (const f of input.fields) {
      const idx = s.field_assessments.findIndex(
        (a) => a.field_id === f.field_id && a.encounter_id === input.noteId,
      );
      const assessment: FieldAssessment = {
        field_id: f.field_id,
        answer: f.answer,
        confidence: f.confidence,
        evidence: f.evidence,
        rationale: f.rationale,
        source: "agent",
        status: "agent_proposed",
        updated_at: now,
        updated_by: "agent",
        encounter_id: input.noteId,
      };
      if (idx >= 0) s.field_assessments[idx] = assessment;
      else s.field_assessments.push(assessment);
    }
    // Refresh derived fields for this note's scope (e.g. apoe2/3/4 from the
    // genotype). The custom mutator above bypasses applySetAssessmentMutation,
    // so derivation must be triggered here explicitly.
    recomputeDerivedAssessments(s, task);
  });
}

export interface SetAssessmentInput {
  field_id: string;
  answer?: unknown;
  confidence?: "low" | "medium" | "high";
  evidence?: Evidence[];
  rationale?: string;
  status?: AssessmentStatus;
  // Phase B additions (UI / MCP can supply these; ignored by agent)
  edit_reason?: EditReason;
  edit_note?: string;
  comment?: string;
  /** When set, scopes this assessment to one encounter/note. Upserts are keyed
   *  on (field_id, encounter_id) so per-note labels for the same field coexist. */
  encounter_id?: string;
}

export interface SetAssessmentResult {
  state: ReviewState;
  warnings: string[];
}

export class ReviewStateError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Apply a set_field_assessment action. Validates the field exists in
 * the compiled task and runs faithfulness pre-check on every cited note
 * quote BEFORE persisting. Faithfulness failure aborts the write.
 */
export function applySetAssessment(
  patientId: string,
  task: CompiledTask,
  by: AssessmentSource,
  by_id: string,
  action: SetAssessmentInput,
): SetAssessmentResult {
  const field = task.fields.find((f) => f.id === action.field_id);
  if (!field) {
    throw new ReviewStateError(
      "unknown_field",
      `field_id ${action.field_id} is not part of task ${task.task_id}`,
    );
  }

  // Assignment guard — when assigned_to has entries, only assigned reviewers
  // can write field assessments. Lead reviewers can still set_assigned_to /
  // set_review_status. assigned_to=[] means unassigned (back-compat).
  const current = loadOrCreate(patientId, task);
  if (
    current.assigned_to &&
    current.assigned_to.length > 0 &&
    by === "reviewer" &&
    !current.assigned_to.includes(by_id)
  ) {
    throw new ReviewStateError(
      "ASSIGNMENT_REQUIRED",
      `Reviewer "${by_id}" is not assigned to this record (assigned: ${current.assigned_to.join(", ")})`,
    );
  }

  const warnings = verifyFaithfulnessForSetAssessment(patientId, action);

  const state = mutate(patientId, task, by, (s) => {
    applySetAssessmentMutation(s, by, by_id, action, task);
  });

  return { state, warnings };
}

/**
 * Pure helper: mutate the assessment list inside `s` for a set_field_assessment
 * action. Encapsulates the capture-predicate logic so both applySetAssessment
 * and the UiAction transition core can share it.
 */
function applySetAssessmentMutation(
  s: ReviewState,
  by: AssessmentSource,
  by_id: string,
  action: SetAssessmentInput,
  task?: CompiledTask,
): void {
  const idx = s.field_assessments.findIndex(
    (a) => a.field_id === action.field_id && a.encounter_id === action.encounter_id,
  );
  const existing = idx >= 0 ? s.field_assessments[idx] : undefined;

  // If a reviewer is editing an agent-proposed answer, mark overridden.
  let status: AssessmentStatus =
    action.status ??
    (by === "agent"
      ? "agent_proposed"
      : existing && existing.source === "agent"
        ? "overridden"
        : "approved");

  // CAPTURE PREDICATE — server-authoritative. Spec §5.5.
  // Snapshot is taken from the *prior* FieldAssessment only when:
  //   1. No snapshot has been recorded yet (sticky — never overwrite).
  //   2. The prior writer was the agent.
  //   3. The current writer is the reviewer.
  // Branch (c): reviewer is the first writer → existing is undefined → no snapshot.
  // Branch (b): snapshot already set → !original_agent_snapshot is false → no overwrite.
  let original_agent_snapshot: OriginalAgentSnapshot | undefined =
    existing?.original_agent_snapshot;
  if (
    !original_agent_snapshot &&
    existing?.source === "agent" &&
    by === "reviewer"
  ) {
    original_agent_snapshot = {
      answer: existing.answer,
      evidence: existing.evidence,
      rationale: existing.rationale,
      confidence: existing.confidence,
      captured_at: new Date().toISOString(),
      captured_from_version: s.version,
    };
  }

  // Stamp the criterion's current schema_hash so downstream revisit logic
  // can detect when this record was captured against an older criterion
  // version. Best-effort — when the snapshot returns nothing for this
  // field_id (e.g., during tests with bare in-memory tasks, or before any
  // criteria have been added), the field remains undefined.
  let captured_against_schema_hash: string | undefined;
  try {
    if (task) {
      const hashes = snapshotCriterionHashesSync(task.task_id);
      captured_against_schema_hash = hashes[action.field_id];
    }
  } catch {
    // Snapshot failed (e.g., skill dir missing in test fixtures). The field
    // remains undefined; this is the documented back-compat path.
  }

  // Provenance refinement for derived fields. When the reviewer is
  // confirming the auto-computed value (Confirm & next on the Computed
  // panel), the action's answer equals evalDerivation(...) for this
  // field. Persist as source="derived" rather than "reviewer" so the
  // dropdown badge reads "Derived" and the recompute step continues to
  // refresh it on subsequent leaf writes. A reviewer who instead types
  // a different value (manual override) still lands as source="reviewer"
  // and the recompute will preserve their edit.
  let effectiveSource: AssessmentSource = by;
  if (task && by === "reviewer") {
    const f = task.fields.find((x) => x.id === action.field_id);
    if (f?.derivation) {
      const env: Record<string, unknown> = {};
      for (const fa of s.field_assessments) {
        if (fa.field_id === action.field_id) continue;
        if (fa.answer !== undefined) env[fa.field_id] = fa.answer;
      }
      const computed = evalDerivation(task, env, action.field_id);
      if (
        computed !== null &&
        computed !== undefined &&
        JSON.stringify(action.answer) === JSON.stringify(computed)
      ) {
        effectiveSource = "derived";
      }
    }
  }

  const assessment: FieldAssessment = {
    field_id: action.field_id,
    answer: action.answer,
    confidence: action.confidence,
    evidence: action.evidence,
    rationale: action.rationale,
    source: effectiveSource,
    status,
    updated_at: nowIso(),
    updated_by: by_id,
    edit_reason: action.edit_reason,
    edit_note: action.edit_note,
    original_agent_snapshot,
    comment: action.comment,
    captured_against_schema_hash,
    encounter_id: action.encounter_id,
  };

  if (idx >= 0) s.field_assessments[idx] = assessment;
  else s.field_assessments.push(assessment);

  if (s.review_status === "draft") s.review_status = "in_progress";

  // After a leaf change, refresh every derived field whose inputs are now
  // available. Skip fields a reviewer has manually answered (source ==
  // "reviewer") so manual overrides survive subsequent leaf writes.
  if (task) recomputeDerivedAssessments(s, task);
}

/**
 * Walk every field with a `derivation` expression. Evaluate it against the
 * current answers env; upsert a FieldAssessment with source="derived" when
 * the result is non-null. Skips fields whose existing assessment was written
 * by a reviewer (manual override wins).
 *
 * Called from applySetAssessmentMutation after every leaf write so derived
 * rollups (e.g. lung_cancer_status) stay in sync without an agent run. Cheap:
 * O(fields × derived) per write on small rubrics.
 */
/** Categories that are entity-handling sentinels, not real guideline vaccine
 *  categories — excluded from the projected vaccine_category summary. */
const NON_GUIDELINE_VACCINE_CATEGORIES = new Set(["Not a vaccine", "Ambiguous"]);

/** Parse a `derivation` of the form `entity_attr(<field>, <attribute>)`, used to
 *  project an entity-list field's attribute into a standalone derived array.
 *  Returns null for ordinary scalar-DSL derivations. */
export function parseEntityProjection(
  derivation: string | undefined,
): { field: string; attribute: string } | null {
  const m = (derivation ?? "").match(
    /^\s*entity_attr\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*$/,
  );
  return m ? { field: m[1]!, attribute: m[2]! } : null;
}

/** Project an entity-list answer to the distinct, sorted, real values of one
 *  attribute (e.g. each vaccine's Category). Returns null when the source field
 *  has no entities in scope so recompute leaves the slot empty. */
export function projectEntityAttribute(entityAnswer: unknown, attribute: string): string[] | null {
  if (!Array.isArray(entityAnswer)) return null;
  const vals: string[] = [];
  for (const rec of entityAnswer) {
    if (rec && typeof rec === "object" && !Array.isArray(rec)) {
      const v = (rec as Record<string, unknown>)[attribute];
      if (typeof v === "string" && v.trim() && !NON_GUIDELINE_VACCINE_CATEGORIES.has(v.trim())) {
        vals.push(v.trim());
      }
    }
  }
  const distinct = [...new Set(vals)].sort();
  return distinct.length ? distinct : null;
}

function recomputeDerivedAssessments(s: ReviewState, task: CompiledTask): void {
  const derivedFields = task.fields.filter((f) => f.derivation);
  if (derivedFields.length === 0) return;
  const derivedIds = new Set(derivedFields.map((f) => f.id));

  // Derivation is evaluated once per ENCOUNTER SCOPE. A scope is the
  // encounter_id carried by the leaf (non-derived) answers: per-note tasks
  // yield one scope per note (encounter_id = note_id); patient-level tasks
  // yield a single `undefined` scope — identical to the pre-encounter
  // behavior (undefined === undefined upserts), so this is backward
  // compatible for tasks like cancer's disease_extent.
  const scopes = new Set<string | undefined>();
  for (const fa of s.field_assessments) {
    if (derivedIds.has(fa.field_id)) continue;
    if (fa.answer !== undefined) scopes.add(fa.encounter_id);
  }
  if (scopes.size === 0) scopes.add(undefined);

  const now = nowIso();
  for (const scope of scopes) {
    // Env from the answers in THIS scope only (so each note derives from its
    // own genotype, not a mix). Includes derived answers in-scope for any
    // chained derivations, matching the prior single-env semantics.
    const answers: Record<string, unknown> = {};
    for (const fa of s.field_assessments) {
      if (fa.encounter_id !== scope) continue;
      if (fa.answer !== undefined) answers[fa.field_id] = fa.answer;
    }
    for (const f of derivedFields) {
      const existingIdx = s.field_assessments.findIndex(
        (x) => x.field_id === f.id && x.encounter_id === scope,
      );
      const existing = existingIdx >= 0 ? s.field_assessments[existingIdx] : null;
      // Preserve manual reviewer-authored answers on derived fields.
      if (existing && existing.source === "reviewer") continue;

      // Entity-attribute projection: a derived field can summarize an
      // entity-list field's attribute into a standalone array (e.g.
      // vaccine_category = the distinct vaccine categories projected from each
      // vaccine_name entity's Category attribute). The scalar derivation DSL
      // can't express "map over an entity list", so handle it here.
      const proj = parseEntityProjection(f.derivation);
      const value = proj
        ? projectEntityAttribute(answers[proj.field], proj.attribute)
        : evalDerivation(task, answers, f.id);
      if (value === null || value === undefined) {
        // Inputs not yet complete — leave the slot empty so the dropdown still
        // shows "Pending" rather than a stale or fabricated value.
        continue;
      }
      // If the recomputed value is identical to what's already stored, skip the
      // overwrite to preserve `updated_by`/`updated_at` (e.g. a reviewer's
      // Re-confirm). Without this, every leaf write clobbers it to "system".
      if (existing && JSON.stringify(existing.answer) === JSON.stringify(value)) {
        continue;
      }
      const derived: FieldAssessment = {
        field_id: f.id,
        answer: value,
        rationale: `auto-derived: ${f.derivation}`,
        source: "derived",
        status: "approved",
        updated_at: now,
        updated_by: "system",
        encounter_id: scope,
      };
      if (existingIdx >= 0) s.field_assessments[existingIdx] = derived;
      else s.field_assessments.push(derived);
    }
  }
}

/** Max characters allowed in a cited NOTE quote. The minimal-span rule asks
 *  agents to cite the specific finding clause; this caps egregious dumps (a
 *  whole discharge-summary header is ~5k chars) while staying far above any
 *  real clause (observed correct citations were 33–74 chars). */
export const MAX_NOTE_QUOTE_CHARS = 1000;

/** Enforce the minimal-span rule for note citations: a note quote longer than
 *  MAX_NOTE_QUOTE_CHARS is rejected so the agent re-cites the specific clause.
 *  No-op for omop/structured evidence. Throws ReviewStateError("quote_too_long").
 *  Called inside applyUiAction, so runAction converts the throw into a
 *  recoverable {ok:false} result the agent can read and retry from — exactly
 *  like the faithfulness gate (which is why this lives here, not in
 *  mcp-core's ensureEvidenceShape, which runs outside that try/catch). */
export function assertQuoteWithinLimit(ev: { source: string; verbatim_quote?: string }): void {
  if (ev.source !== "note") return;
  const len = ev.verbatim_quote?.length ?? 0;
  if (len > MAX_NOTE_QUOTE_CHARS) {
    throw new ReviewStateError(
      "quote_too_long",
      `Cited quote is ${len} chars (max ${MAX_NOTE_QUOTE_CHARS}). Cite the specific ` +
        `clause or sentence that states the finding — not the note header, ` +
        `demographics, or a whole section. Re-run find_quote_offsets on that ` +
        `shorter clause and retry.`,
    );
  }
}

/**
 * Enum gate for set_field_assessment. When a field declares a non-empty
 * `answer_schema.enum`, the answer MUST be one of those values (each element,
 * for cardinality "many"). Rejects off-enum free text — e.g. an agent writing
 * "adenosquamous carcinoma" when the enum only has adenocarcinoma/…/other — so
 * the stored answer is always comparable to reviewer gold (exact-match scoring
 * is meaningless if the agent can invent values). Skips fields with no enum
 * (free-text/numeric) and a null/empty answer (cleared / not answered). The
 * error lists the allowed values + the escape hatches so the agent can retry.
 */
export function assertAnswerInEnum(
  field: { id: string; answer_schema?: unknown },
  answer: unknown,
): void {
  const schema = field.answer_schema as { enum?: unknown } | undefined;
  const enumValues = Array.isArray(schema?.enum) ? (schema!.enum as unknown[]).map(String) : null;
  if (!enumValues || enumValues.length === 0) return; // free-text / numeric field
  const values = Array.isArray(answer) ? answer : [answer];
  for (const v of values) {
    if (v == null || v === "") continue; // not answered / cleared
    if (!enumValues.includes(String(v).trim())) {
      throw new ReviewStateError(
        "answer_not_in_enum",
        `answer ${JSON.stringify(v)} for field "${field.id}" is not an allowed value. ` +
          `Choose exactly one of: ${enumValues.join(", ")}. ` +
          `Map the finding to the closest allowed value; if none fit, use "other" or "no_info".`,
      );
    }
  }
}

/**
 * Canonicalize an enum answer to the enum value's own type, so a numeric-scored
 * field stores `2` (number) when the agent wrote `"2"` (string). Without this a
 * derivation summing those fields concatenates strings ("2"+"3" -> "23"). Match
 * is by trimmed string equality (so "2" -> the enum's 2); non-enum fields and
 * unmatched answers pass through unchanged. Run AFTER assertAnswerInEnum.
 */
export function canonicalizeEnumAnswer(
  field: { answer_schema?: unknown },
  answer: unknown,
): unknown {
  const schema = field.answer_schema as { enum?: unknown } | undefined;
  const enumValues = Array.isArray(schema?.enum) ? (schema!.enum as unknown[]) : null;
  if (!enumValues || answer == null || Array.isArray(answer)) return answer;
  const match = enumValues.find((e) => String(e).trim() === String(answer).trim());
  return match !== undefined ? match : answer;
}

/**
 * Range gate for numeric criteria. When answer_schema declares a numeric type
 * (integer / number), a non-null answer must be a finite number (an integer for
 * integer fields) within [minimum, maximum]. Enum / free-text fields and
 * null/empty answers (cleared / not answered) are skipped. Run alongside
 * assertAnswerInEnum so an off-range score can't poison numeric scoring.
 */
export function assertAnswerInRange(
  field: { id: string; answer_schema?: unknown },
  answer: unknown,
): void {
  const schema = field.answer_schema as { type?: string; minimum?: number; maximum?: number } | undefined;
  const t = schema?.type;
  if (t !== "integer" && t !== "number") return; // not a numeric field
  if (answer == null || answer === "") return; // not answered / cleared
  const n = typeof answer === "number" ? answer : Number(String(answer).trim());
  const lo = schema?.minimum, hi = schema?.maximum;
  const bad =
    !Number.isFinite(n) ||
    (t === "integer" && !Number.isInteger(n)) ||
    (typeof lo === "number" && n < lo) ||
    (typeof hi === "number" && n > hi);
  if (bad) {
    const range = typeof lo === "number" && typeof hi === "number" ? ` in [${lo}, ${hi}]` : "";
    throw new ReviewStateError(
      "answer_out_of_range",
      `answer ${JSON.stringify(answer)} for field "${field.id}" must be a${t === "integer" ? "n integer" : " number"}${range}.`,
    );
  }
}

/** Coerce a numeric field's answer to a number ("21" -> 21) so reviewer and
 *  agent store the same type — exact-match scoring depends on it. Non-numeric
 *  fields / null pass through. Run AFTER assertAnswerInRange. */
export function canonicalizeNumericAnswer(
  field: { answer_schema?: unknown },
  answer: unknown,
): unknown {
  const schema = field.answer_schema as { type?: string } | undefined;
  const t = schema?.type;
  if ((t !== "integer" && t !== "number") || answer == null || answer === "") return answer;
  const n = typeof answer === "number" ? answer : Number(String(answer).trim());
  return Number.isFinite(n) ? n : answer;
}

/** Coerce a free-text (answer_schema type "string") field's answer to a string,
 *  so a numeric-looking value (e.g. a quit year written as 2008) is stored as
 *  "2008" rather than the JS number 2008 — keeping the persisted answer
 *  schema-conformant for downstream equality / scoring / display. Non-string
 *  fields and null/undefined pass through unchanged. */
export function canonicalizeStringAnswer(
  field: { answer_schema?: unknown },
  answer: unknown,
): unknown {
  const schema = field.answer_schema as { type?: string } | undefined;
  if (schema?.type !== "string" || answer == null) return answer;
  return typeof answer === "string" ? answer : String(answer);
}

/**
 * Numeric-grounding gate. A numeric SCALE criterion (answer_schema type
 * integer/number, NOT an enum) answered with a concrete value must have that
 * value present in at least one cited note quote.
 *
 * This blocks a failure mode seen on real (sparse) charts: the commit gate
 * pushes the agent to answer every criterion, so for an UNDOCUMENTED scale it
 * defaults to 0 (or any placeholder) with a non-numeric citation — injecting a
 * fake score (e.g. MoCA 0 = profound impairment) that then cascades into the
 * derived severity bands. When the chart documents no value, the legitimate
 * answer is null: the commit gate accepts a null assessment (presence, not
 * value) and the range gate skips null — so the agent never needs to fabricate
 * a number. Only pure numeric scales are gated; binary/categorical enum flags
 * (impaired_cognition=0, CDR staging) are skipped — there a 0 / negation answer
 * is legitimate and its evidence carries no digit. Run AFTER assertAnswerInRange.
 *
 * Opt-out: a field whose frontmatter declares `numeric_grounding: "structured"`
 * is exempt — its value is COMPUTED from structured (OMOP) data, not read as a
 * documented scale, so the number legitimately never appears verbatim in a note
 * (e.g. RUCAM onset_latency_days = −start_day from get_drug_episodes). Gating it
 * would force null and Pend every downstream derivation. Its provenance is the
 * deterministic tool output, auditable in the transcript, and adjudicable by the
 * reviewer. The default (absent flag) stays note-grounded.
 */
export function assertNumericAnswerCited(
  field: { id: string; answer_schema?: unknown; numeric_grounding?: string },
  answer: unknown,
  evidence: Array<{ source?: string; verbatim_quote?: string }> | undefined,
): void {
  const schema = field.answer_schema as { type?: string; enum?: unknown[] } | undefined;
  const t = schema?.type;
  if (t !== "integer" && t !== "number") return; // not a numeric field
  if (Array.isArray(schema?.enum) && schema!.enum!.length > 0) return; // numeric-coded enum (staging) → categorical
  if (field.numeric_grounding === "structured") return; // value computed from structured data → no note digit exists
  if (answer == null || answer === "") return; // null/absent IS the "not documented" path
  const n = typeof answer === "number" ? answer : Number(String(answer).trim());
  if (!Number.isFinite(n)) return; // non-numbers are assertAnswerInRange's job
  const token = String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // the answer's numeric value must appear as a standalone number in a cited span
  const re = new RegExp(`(?<![\\d.])${token}(?![\\d.])`);
  const grounded = (evidence ?? [])
    .filter((e) => e?.source === "note")
    .some((e) => re.test(e?.verbatim_quote ?? ""));
  if (!grounded) {
    throw new ReviewStateError(
      "numeric_not_cited",
      `numeric field "${field.id}" was answered ${JSON.stringify(answer)} but no cited note quote contains that number. ` +
        "If the chart documents no value for this scale, leave the answer null (do NOT write 0 or a placeholder). " +
        "If a value IS documented, cite the exact note span that contains the number.",
    );
  }
}

interface EntitySchema {
  type?: string;
  entity?: {
    value_key?: string;
    attributes?: Record<string, { enum?: unknown[] } | undefined>;
  };
}

/**
 * Entity-array gate. When answer_schema.type === "array" the answer is a JSON
 * list of entity records — the guideline's entity-span output (e.g. allergen,
 * vaccine_name). Each record must carry a non-empty value at the entity's
 * value_key plus a non-empty Supporting_Evidence; any attribute that IS present
 * must (if enum-typed) be in its allowed set. An empty list `[]` (= none
 * documented / NKDA) and null/"" (not answered) are both valid.
 */
export function assertAnswerEntities(
  field: { id: string; answer_schema?: unknown },
  answer: unknown,
  requireEvidence = true,
): void {
  const schema = field.answer_schema as EntitySchema | undefined;
  if (schema?.type !== "array") return; // not an entity-array field
  if (answer == null || answer === "") return; // not answered
  if (!Array.isArray(answer)) {
    throw new ReviewStateError(
      "answer_not_array",
      `field "${field.id}" expects a list of entity records, got ${typeof answer}.`,
    );
  }
  const valueKey = schema.entity?.value_key ?? "value";
  const attrs = schema.entity?.attributes ?? {};
  answer.forEach((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ReviewStateError("entity_not_object", `field "${field.id}" entity[${i}] must be an object.`);
    }
    const rec = item as Record<string, unknown>;
    if (rec[valueKey] == null || String(rec[valueKey]).trim() === "") {
      throw new ReviewStateError("entity_missing_value", `field "${field.id}" entity[${i}] is missing required "${valueKey}".`);
    }
    // Supporting_Evidence is required of the AGENT (anti-fabrication); a human
    // reviewer adjudicating may enter an entity without pasting a quote.
    if (requireEvidence && (rec.Supporting_Evidence == null || String(rec.Supporting_Evidence).trim() === "")) {
      throw new ReviewStateError("entity_missing_evidence", `field "${field.id}" entity[${i}] is missing required "Supporting_Evidence".`);
    }
    for (const [k, spec] of Object.entries(attrs)) {
      const av = rec[k];
      if (av == null || String(av).trim() === "") continue; // attributes optional
      const en = spec?.enum;
      if (Array.isArray(en) && !en.map(String).includes(String(av).trim())) {
        throw new ReviewStateError(
          "entity_attr_off_enum",
          `field "${field.id}" entity[${i}].${k}="${av}" is not one of [${en.map(String).join(", ")}].`,
        );
      }
    }
  });
}

/**
 * Per-entity faithfulness (AGENT writes only — reviewers exempt, mirroring the
 * numeric guard). Each entity's Supporting_Evidence quote must be verbatim
 * present (whitespace-normalized) in one of the patient's notes — blocking a
 * fabricated allergen/vaccine that cites text not in the chart.
 */
export function assertEntityEvidenceFaithful(
  patientId: string,
  field: { id: string; answer_schema?: unknown },
  answer: unknown,
): void {
  const schema = field.answer_schema as EntitySchema | undefined;
  if (schema?.type !== "array" || !Array.isArray(answer) || answer.length === 0) return;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  let corpus: string;
  try {
    corpus = listNotes(patientId).map((n) => readNote(patientId, n.filename)).join("\n");
  } catch {
    return; // notes unreadable → don't block on infra error (cited-span gate still applies)
  }
  const nc = norm(corpus);
  answer.forEach((item, i) => {
    const q = (item as Record<string, unknown> | null)?.Supporting_Evidence;
    const nq = typeof q === "string" ? norm(q) : "";
    if (nq && !nc.includes(nq)) {
      throw new ReviewStateError(
        "entity_evidence_unfaithful",
        `field "${field.id}" entity[${i}] cites Supporting_Evidence not found verbatim in any note — cite the exact documented span, do not fabricate.`,
      );
    }
  });
}

/**
 * Faithfulness gate for set_field_assessment. Throws on fabrication;
 * returns any non-fatal warnings. Pure: no state writes.
 */
function verifyFaithfulnessForSetAssessment(
  patientId: string,
  action: SetAssessmentInput,
): string[] {
  const warnings: string[] = [];
  for (const ev of action.evidence ?? []) {
    if (ev.source !== "note") continue;
    assertQuoteWithinLimit(ev);
    const result = verifyEvidence(patientId, ev);
    if (result.status === "fail") {
      throw new ReviewStateError(
        "faithfulness_failed",
        `evidence offsets do not resolve in ${ev.note_id}: ${result.detail}`,
      );
    }
    // Quote verified but cited at the wrong offsets — persist the corrected
    // span so downstream highlighting points at the real location.
    if (result.corrected_offsets && ev.source === "note") {
      ev.span_offsets = result.corrected_offsets;
    }
    if (result.detail) warnings.push(result.detail);
  }
  return warnings;
}

/**
 * Faithfulness gate for select_evidence. Throws on fabrication.
 */
function verifyFaithfulnessForSelectEvidence(
  patientId: string,
  action: SelectEvidenceInput,
): void {
  if (action.evidence.source === "note") {
    assertQuoteWithinLimit(action.evidence);
    const result = verifyEvidence(patientId, action.evidence);
    if (result.status === "fail") {
      throw new ReviewStateError(
        "faithfulness_failed",
        `evidence offsets do not resolve in ${action.evidence.note_id}: ${result.detail}`,
      );
    }
    if (result.corrected_offsets) {
      action.evidence.span_offsets = result.corrected_offsets;
    }
  }
}

export function applySetSummary(
  patientId: string,
  task: CompiledTask,
  by: AssessmentSource,
  by_id: string,
  summary: ReviewSummary,
): ReviewState {
  return mutate(patientId, task, by, (s) => {
    s.summary = {
      ...summary,
      updated_at: nowIso(),
      updated_by: by_id,
    };
    if (s.review_status === "draft") s.review_status = "in_progress";
  });
}

export interface SelectEvidenceInput {
  evidence: Evidence;
  rationale?: string;
  category?: "supporting" | "contradicting" | "context";
  field_id?: string;
}

export function applySelectEvidence(
  patientId: string,
  task: CompiledTask,
  by: AssessmentSource,
  by_id: string,
  action: SelectEvidenceInput,
): SelectedEvidence {
  // Faithfulness pre-check on note evidence — same gate as the
  // field-assessment path. Fabricated quotes are rejected here too.
  verifyFaithfulnessForSelectEvidence(patientId, action);

  let added!: SelectedEvidence;
  mutate(patientId, task, by, (s) => {
    if (!s.selected_evidence) s.selected_evidence = [];
    added = {
      id: randomUUID(),
      evidence: action.evidence,
      rationale: action.rationale,
      category: action.category,
      field_id: action.field_id,
      added_at: nowIso(),
      added_by: by_id,
    };
    s.selected_evidence.push(added);
  });
  return added;
}

export function clearSelectedEvidence(
  patientId: string,
  task: CompiledTask,
  by: AssessmentSource,
  evidenceId?: string,
): ReviewState {
  return mutate(patientId, task, by, (s) => {
    if (!s.selected_evidence) return;
    if (evidenceId) {
      s.selected_evidence = s.selected_evidence.filter(
        (e) => e.id !== evidenceId,
      );
    } else {
      s.selected_evidence = [];
    }
  });
}

export function applyRecommendKeywords(
  patientId: string,
  task: CompiledTask,
  by: AssessmentSource,
  by_id: string,
  kws: KeywordSuggestions,
): ReviewState {
  return mutate(patientId, task, by, (s) => {
    s.keyword_suggestions = {
      ...kws,
      updated_at: nowIso(),
      updated_by: by_id,
    };
  });
}

/**
 * Reset the review state to a fresh "draft" with no assessments / summary
 * / pinned evidence / keyword suggestions. The audit-trail JSONLs under
 * chat/ are preserved (history is not destroyed; just the live state).
 */
export function resetReviewState(
  patientId: string,
  task: CompiledTask,
): ReviewState {
  const initial: ReviewState = {
    schema_version: SCHEMA_VERSION,
    patient_id: patientId,
    task_id: task.task_id,
    task_version: task.manual_version,
    task_document_sha: task.source_document_sha,
    review_status: "draft",
    version: 1,
    updated_at: nowIso(),
    updated_by: "system",
    field_assessments: [],
  };
  writeReviewState(patientId, task.task_id, initial);
  return initial;
}

/**
 * Unified action envelope. Every chat-agent MCP tool and every
 * reviewer-side REST endpoint that mutates review_state.json is
 * expressed as one of these types. The discriminated union lives ONLY
 * on the server (in TypeScript and validated at the boundary) — we do
 * not expose it as a single MCP tool schema, because Together-routed
 * DeepSeek rejects discriminated unions (anyOf) in tool param schemas.
 *
 * To add a new action type:
 *   1. Add a variant here.
 *   2. Add a case in transitionReviewState's switch.
 *   3. Either add a new MCP tool (preferred — the agent picks better
 *      with named tools) OR accept it via POST /api/reviews/.../actions.
 */
export interface SetReviewStatusInput {
  review_status: ReviewState["review_status"];
  updated_by?: string;
  locked_at?: string;
  locked_by?: string;
  lock_task_sha?: string;
}

export type UiAction =
  | {
      type: "set_field_assessment";
      payload: SetAssessmentInput;
    }
  | {
      type: "set_summary";
      payload: ReviewSummary;
    }
  | {
      type: "recommend_keywords";
      payload: KeywordSuggestions;
    }
  | {
      type: "select_evidence";
      payload: SelectEvidenceInput;
    }
  | {
      type: "clear_selected_evidence";
      payload: { evidence_id?: string };
    }
  | {
      type: "set_review_status";
      payload: SetReviewStatusInput;
    }
  | { type: "set_assigned_to"; payload: { assigned_to: string[]; updated_by?: string } }
  | {
      type: "add_encounter";
      payload: {
        kind: "encounter" | "episode";
        date?: string;
        label?: string;
        note_ids?: string[];
      };
    }
  | { type: "remove_encounter"; payload: { encounter_id: string } };

export interface ApplyUiActionResult {
  state: ReviewState;
  warnings: string[];
  /** For select_evidence — the id of the entry just added. */
  added_evidence_id?: string;
  /** For add_encounter — the id of the encounter just added. */
  added_encounter_id?: string;
}

/**
 * Per-action transition outcome from the pure core. Carries the new
 * state plus any derived ids (e.g. select_evidence's added_evidence_id)
 * that callers need to surface back to the UI / MCP tool reply.
 */
export interface TransitionResult {
  state: ReviewState;
  warnings: string[];
  added_evidence_id?: string;
  added_encounter_id?: string;
}

// ── Side-effect-free transition core ────────────────────────────────────────

/**
 * PURE state transition: (currentState, task, action) → newState.
 *
 * Has no I/O, no audit append, no disk write, no fire-and-forget. Faithfulness
 * is NOT verified here — that's the verifyFaithfulnessForAction gate that runs
 * BEFORE this function. Lock and assignment guards are also called by the
 * outer applyUiAction wrapper.
 *
 * The function takes a fresh copy of `current` (doesn't mutate the caller's
 * object) and returns a new state with version bumped, updated_at refreshed,
 * cross_criterion_alerts recomputed.
 *
 * Exported for unit tests that want to exercise transitions without any
 * filesystem fixtures.
 */
export function transitionReviewState(
  current: ReviewState,
  task: CompiledTask,
  by: AssessmentSource,
  by_id: string,
  action: UiAction,
): TransitionResult {
  // Deep-clone so the caller's input is untouched. JSON round-trip is fine
  // here — ReviewState is plain data (no class instances, no functions, no
  // Dates).
  const s: ReviewState = JSON.parse(JSON.stringify(current));
  const result: TransitionResult = { state: s, warnings: [] };

  switch (action.type) {
    case "set_field_assessment": {
      const field = task.fields.find((f) => f.id === action.payload.field_id);
      if (!field) {
        throw new ReviewStateError(
          "unknown_field",
          `field_id ${action.payload.field_id} is not part of task ${task.task_id}`,
        );
      }
      assertAnswerInEnum(field, action.payload.answer);
      assertAnswerInRange(field, action.payload.answer);
      assertAnswerEntities(field, action.payload.answer, by === "agent");
      // Numeric-grounding gate applies to AGENT writes only — reviewers are the
      // trusted adjudicators and may enter a chart-read value without machine
      // citation; the gate exists to stop an agent fabricating an undocumented score.
      if (by === "agent") {
        assertNumericAnswerCited(
          field,
          action.payload.answer,
          action.payload.evidence as Array<{ source?: string; verbatim_quote?: string }> | undefined,
        );
      }
      const canonicalPayload = {
        ...action.payload,
        answer: canonicalizeStringAnswer(
          field,
          canonicalizeNumericAnswer(field, canonicalizeEnumAnswer(field, action.payload.answer)),
        ),
      };
      applySetAssessmentMutation(s, by, by_id, canonicalPayload, task);
      break;
    }
    case "set_summary": {
      s.summary = { ...action.payload, updated_at: nowIso(), updated_by: by_id };
      if (s.review_status === "draft") s.review_status = "in_progress";
      break;
    }
    case "recommend_keywords": {
      s.keyword_suggestions = {
        ...action.payload,
        updated_at: nowIso(),
        updated_by: by_id,
      };
      break;
    }
    case "select_evidence": {
      if (!s.selected_evidence) s.selected_evidence = [];
      const added: SelectedEvidence = {
        id: randomUUID(),
        evidence: action.payload.evidence,
        rationale: action.payload.rationale,
        category: action.payload.category,
        field_id: action.payload.field_id,
        added_at: nowIso(),
        added_by: by_id,
      };
      s.selected_evidence.push(added);
      result.added_evidence_id = added.id;
      break;
    }
    case "clear_selected_evidence": {
      if (s.selected_evidence) {
        const id = action.payload?.evidence_id;
        if (id) {
          s.selected_evidence = s.selected_evidence.filter((e) => e.id !== id);
        } else {
          s.selected_evidence = [];
        }
      }
      break;
    }
    case "set_review_status": {
      s.review_status = action.payload.review_status;
      if (action.payload.updated_by !== undefined)
        s.updated_by = action.payload.updated_by as AssessmentSource | "system";
      if (action.payload.locked_at !== undefined) s.locked_at = action.payload.locked_at;
      if (action.payload.locked_by !== undefined) s.locked_by = action.payload.locked_by;
      if (action.payload.lock_task_sha !== undefined)
        s.lock_task_sha = action.payload.lock_task_sha;
      break;
    }
    case "set_assigned_to": {
      s.assigned_to = action.payload.assigned_to;
      if (action.payload.updated_by !== undefined)
        s.updated_by = action.payload.updated_by as AssessmentSource | "system";
      break;
    }
    case "add_encounter": {
      if (!s.encounters) s.encounters = [];
      const newId = randomUUID();
      s.encounters.push({
        encounter_id: newId,
        kind: action.payload.kind,
        date: action.payload.date,
        label: action.payload.label,
        note_ids: action.payload.note_ids,
      });
      result.added_encounter_id = newId;
      break;
    }
    case "remove_encounter": {
      if (s.encounters) {
        s.encounters = s.encounters.filter(
          (e) => e.encounter_id !== action.payload.encounter_id,
        );
      }
      break;
    }
    default: {
      const _exhaustive: never = action;
      throw new ReviewStateError(
        "unknown_action",
        `unknown action type: ${(_exhaustive as { type: string }).type}`,
      );
    }
  }

  // Derived: recompute alerts inside the transition so persisted state always
  // carries the latest cross_criterion_alerts. Pure (no I/O).
  recomputeAlerts(task, s);

  // Bump bookkeeping fields. Note set_review_status / set_assigned_to may have
  // already overridden updated_by inside the case body — we only set it here
  // if it wasn't customised.
  s.version += 1;
  s.updated_at = nowIso();
  // Preserve any in-action override (e.g. set_review_status with explicit updated_by)
  if (
    action.type !== "set_review_status" &&
    action.type !== "set_assigned_to"
  ) {
    s.updated_by = by;
  } else if (
    (action.type === "set_review_status" && action.payload.updated_by === undefined) ||
    (action.type === "set_assigned_to" && action.payload.updated_by === undefined)
  ) {
    s.updated_by = by;
  }

  return result;
}

// ── Side effects (each takes the action context; called in sequence) ────────

/**
 * Pre-transition gate: rejects actions that cite fabricated note quotes.
 * Throws ReviewStateError("faithfulness_failed", ...) on first failure.
 * Returns warnings (non-fatal detail strings) for the caller to surface.
 *
 * The set of action types that need a faithfulness check is small:
 *   - set_field_assessment  (cites evidence on a field answer)
 *   - select_evidence       (pins a piece of evidence)
 * Other actions never carry note offsets; they pass through.
 */
export function verifyFaithfulnessForAction(
  patientId: string,
  action: UiAction,
): string[] {
  switch (action.type) {
    case "set_field_assessment":
      return verifyFaithfulnessForSetAssessment(patientId, action.payload);
    case "select_evidence":
      verifyFaithfulnessForSelectEvidence(patientId, action.payload);
      return [];
    default:
      return [];
  }
}

/**
 * Recompute live cross-criterion alerts on `state` in place. This is a
 * derived computation (pure given task + state) but is broken out so the
 * transition core stays readable.
 */
export function recomputeAlerts(task: CompiledTask, state: ReviewState): void {
  state.cross_criterion_alerts = recomputeLiveAlerts(task, state);
}

/**
 * Best-effort drift check after a set_field_assessment write. Appends a
 * drift_alert audit entry on detection and may delegate to the auto-Role-C
 * trigger. Failures are logged and do NOT propagate — the action's persisted
 * state stands.
 */
export function checkDriftAfterAction(
  patientId: string,
  task: CompiledTask,
  action: UiAction,
): void {
  if (action.type !== "set_field_assessment") return;
  try {
    const drift = checkDrift({
      taskId: task.task_id,
      changedFieldId: action.payload.field_id,
      reviewsRoot: reviewsRoot(),
    });
    if (!drift) return;
    const ts = new Date().toISOString();
    appendAuditEntry(
      { patientId, taskId: task.task_id, sessionId: "drift-detector" },
      {
        ts,
        session_id: "drift-detector",
        step_type: "drift_alert",
        field_id: drift.field_id,
        baseline_rate: drift.baseline_rate,
        current_rate: drift.current_rate,
        delta_pp: drift.delta_pp,
        reviewer_id: "system",
      },
    );
    maybeFireAutoRoleC(patientId, task, drift.field_id);
  } catch (e) {
    // Don't let drift-check failures break the write
    console.error("drift-detector error:", e);
  }
}

/**
 * If the cumulative drift_alert count for `fieldId` crosses the auto-Role-C
 * threshold (and no cooldown is active), emit a role_c_auto_run audit entry
 * and fire the analysis. Fire-and-forget; errors are logged but never thrown.
 */
export function maybeFireAutoRoleC(
  patientId: string,
  task: CompiledTask,
  fieldId: string,
): void {
  if (!shouldAutoRoleC({ taskId: task.task_id, reviewsRoot: reviewsRoot(), fieldId })) {
    return;
  }
  // Append the role_c_auto_run audit FIRST so subsequent shouldAutoRoleC
  // calls see the cooldown immediately.
  appendAuditEntry(
    { patientId, taskId: task.task_id, sessionId: "auto-role-c" },
    {
      ts: new Date().toISOString(),
      session_id: "auto-role-c",
      step_type: "role_c_auto_run",
      field_id: fieldId,
      drift_alert_count: 3,
      triggered_by: "system",
    } as never,
  );
  // Fire-and-forget so the write doesn't block
  fireAutoRoleC({ taskId: task.task_id, reviewsRoot: reviewsRoot(), fieldId })
    .catch((e) => console.error("auto-role-c invocation error:", e));
}

// ── Outer orchestrator ──────────────────────────────────────────────────────

/**
 * Apply a UI action: validate → pure transition → write → side effects.
 *
 * Order matters:
 *   1. Faithfulness gate: rejects fabricated note quotes BEFORE any state
 *      mutation. Throws on failure.
 *   2. Load + lock/assignment guards: rejects writes against a locked record
 *      or by an unassigned reviewer.
 *   3. transitionReviewState: pure (state, action) → newState.
 *   4. writeReviewState: atomic disk write.
 *   5. checkDriftAfterAction: best-effort; logs and continues on failure
 *      (a drift-detector outage must not break a clean write).
 *
 * Public signature unchanged so all callers (server.ts routes, MCP tools)
 * keep working without edits.
 */
export function applyUiAction(
  patientId: string,
  task: CompiledTask,
  by: AssessmentSource,
  by_id: string,
  action: UiAction,
): ApplyUiActionResult {
  // 1. Pre-transition gates (any of these THROWS to abort the action).
  const warnings = verifyFaithfulnessForAction(patientId, action);
  // Per-entity faithfulness for entity-array fields (agent writes only) — each
  // entity's Supporting_Evidence must be verbatim in a note.
  if (action.type === "set_field_assessment" && by === "agent") {
    const f = task.fields.find((x) => x.id === action.payload.field_id);
    if (f) assertEntityEvidenceFaithful(patientId, f, action.payload.answer);
  }

  const current = loadOrCreate(patientId, task);
  if (current.review_status === "locked") {
    throw new ReviewStateError("RECORD_LOCKED", "Record is locked; no further writes allowed");
  }
  // Assignment guard — only relevant for field_assessment writes by reviewers.
  if (
    action.type === "set_field_assessment" &&
    by === "reviewer" &&
    current.assigned_to &&
    current.assigned_to.length > 0 &&
    !current.assigned_to.includes(by_id)
  ) {
    throw new ReviewStateError(
      "ASSIGNMENT_REQUIRED",
      `Reviewer "${by_id}" is not assigned to this record (assigned: ${current.assigned_to.join(", ")})`,
    );
  }

  // 2. Pure transition.
  const transition = transitionReviewState(current, task, by, by_id, action);
  transition.warnings = warnings;

  // 3. Disk write (critical — propagates on failure).
  writeReviewState(patientId, task.task_id, transition.state);

  // 4. Best-effort side effects. Each is wrapped to avoid breaking the action.
  try {
    checkDriftAfterAction(patientId, task, action);
  } catch (e) {
    console.warn("checkDriftAfterAction failed:", e);
  }

  // Best-effort iter transition to "validating" on first reviewer cell.
  if (action.type === "set_field_assessment" && by === "reviewer") {
    const reviewerCount = transition.state.field_assessments.filter(
      (fa) => fa.source === "reviewer",
    ).length;
    try {
      maybeTransitionIterToValidating(
        task.task_id,
        patientId,
        action.payload.field_id,
        reviewerCount,
      );
    } catch {
      /* best-effort */
    }
  }

  return {
    state: transition.state,
    warnings,
    added_evidence_id: transition.added_evidence_id,
    added_encounter_id: transition.added_encounter_id,
  };
}

export function load(patientId: string, taskId: string): ReviewState | null {
  const p = statePath(patientId, taskId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as ReviewState;
}
