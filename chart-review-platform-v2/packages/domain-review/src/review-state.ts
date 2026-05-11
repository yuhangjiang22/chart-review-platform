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
import { PLATFORM_ROOT } from "@chart-review/patients";
import { getReviewsRootOverride, withReviewsRoot as _withReviewsRoot } from "@chart-review/reviews-context";
import type { Evidence } from "@chart-review/faithfulness";
import { verifyEvidence } from "@chart-review/faithfulness";
import type { CompiledTask } from "@chart-review/tasks";
import type { CrossCriterionAlert } from "@chart-review/platform-types";
import { recomputeLiveAlerts } from "@chart-review/live-alerts";
import { evalDerivation } from "@chart-review/contract-eval";
import { checkDrift } from "../../../server/lib/drift-detector.js";
import { appendAuditEntry } from "@chart-review/audit-trail";
import { shouldAutoRoleC, fireAutoRoleC } from "../../../server/lib/auto-role-c.js";
import { writeJsonAtomic } from "@chart-review/fs-atomic";
import { snapshotCriterionHashesSync, maybeTransitionIterToValidating } from "../../../server/lib/domain/iter/pilots.js";

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
    (a) => a.field_id === action.field_id,
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
function recomputeDerivedAssessments(s: ReviewState, task: CompiledTask): void {
  const answers: Record<string, unknown> = {};
  for (const fa of s.field_assessments) {
    if (fa.answer !== undefined) answers[fa.field_id] = fa.answer;
  }
  const now = nowIso();
  for (const f of task.fields) {
    if (!f.derivation) continue;
    const existingIdx = s.field_assessments.findIndex((x) => x.field_id === f.id);
    const existing = existingIdx >= 0 ? s.field_assessments[existingIdx] : null;
    // Preserve manual reviewer-authored answers on derived fields.
    if (existing && existing.source === "reviewer") continue;

    const value = evalDerivation(task, answers, f.id);
    if (value === null || value === undefined) {
      // Inputs not yet complete — leave the slot empty so the dropdown still
      // shows "Pending" rather than a stale or fabricated value.
      continue;
    }
    // If the recomputed value is identical to what's already stored,
    // skip the overwrite. This preserves `updated_by` and `updated_at`
    // metadata from the prior write — important when the reviewer just
    // clicked Re-confirm (which sets updated_by to their reviewer_id).
    // Without this, every leaf write would clobber the reviewer's
    // confirmation back to updated_by="system".
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
    };
    if (existingIdx >= 0) s.field_assessments[existingIdx] = derived;
    else s.field_assessments.push(derived);
  }
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
    const result = verifyEvidence(patientId, ev);
    if (result.status === "fail") {
      throw new ReviewStateError(
        "faithfulness_failed",
        `evidence offsets do not resolve in ${ev.note_id}: ${result.detail}`,
      );
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
    const result = verifyEvidence(patientId, action.evidence);
    if (result.status === "fail") {
      throw new ReviewStateError(
        "faithfulness_failed",
        `evidence offsets do not resolve in ${action.evidence.note_id}: ${result.detail}`,
      );
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
      applySetAssessmentMutation(s, by, by_id, action.payload, task);
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
