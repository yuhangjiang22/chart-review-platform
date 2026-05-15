export interface PatientSummary {
  patient_id: string;
  display_name?: string;
  age?: number;
  sex?: string;
  index_date?: string;
  headline?: string;
  category?: string;
  difficulty?: string;
  /** Populated when the listing endpoint is called with a task_id. */
  assigned_to?: string[];
  review_status?: string;
  /** #46 — when true, the patient's data routes through the HIPAA-eligible
   *  model (CHART_REVIEW_PHI_MODEL). Surfaced as a 🔒 PHI badge in the UI. */
  phi?: boolean;
}

export interface NoteListing {
  filename: string;
  date?: string;
  doctype?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_input?: unknown;
  timestamp: string;
}

export interface NoteEvidence {
  source: "note";
  note_id: string;
  span_offsets: [number, number];
  verbatim_quote: string;
  evidence_date?: string;
  doc_type?: string;
  author_role?: string;
}

export interface OmopEvidence {
  source: "omop" | "structured";
  table: string;
  row_id: string | number;
  concept_id?: number;
  concept_name?: string;
  value?: unknown;
  unit?: string;
  evidence_date?: string;
}

export type Evidence = NoteEvidence | OmopEvidence;

export type AssessmentStatus =
  | "pending"
  | "agent_proposed"
  | "approved"
  | "overridden"
  | "not_applicable";

export interface FieldAssessment {
  field_id: string;
  answer?: unknown;
  confidence?: "low" | "medium" | "high";
  evidence?: Evidence[];
  rationale?: string;
  source: "agent" | "reviewer" | "derived";
  status: AssessmentStatus;
  updated_at: string;
  updated_by: string;
  // Phase B additions
  edit_reason?: EditReason;
  edit_note?: string;
  original_agent_snapshot?: OriginalAgentSnapshot;
  /** #45 — encounter/episode scope for this answer. */
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

/** #45 — first-class encounter/episode for guidelines that need per-visit
 *  capture. */
export interface Encounter {
  encounter_id: string;
  kind: "encounter" | "episode";
  date?: string;
  label?: string;
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

export interface SelectedEvidence {
  id: string;
  evidence: Evidence;
  rationale?: string;
  category?: "supporting" | "contradicting" | "context";
  field_id?: string;
  added_at: string;
  added_by: string;
}

export interface ReviewState {
  schema_version: "1";
  patient_id: string;
  task_id: string;
  task_version?: string;
  task_document_sha?: string;
  review_status?: "draft" | "in_progress" | "agent_complete" | "reviewer_validated" | "locked";
  version: number;
  updated_at: string;
  updated_by: string;
  field_assessments: FieldAssessment[];
  summary?: ReviewSummary;
  keyword_suggestions?: KeywordSuggestions;
  selected_evidence?: SelectedEvidence[];
  // Phase B addition
  cross_criterion_alerts?: CrossCriterionAlert[];
  locked_at?: string;
  locked_by?: string;
  lock_task_sha?: string;
  // Batch D-A addition
  assigned_to?: string[];
  /** #45 — encounter/episode list. */
  encounters?: Encounter[];
  /** NER tasks carry their work here instead of field_assessments. Kept
   *  as `unknown[]` on the client so we don't pull the SpanLabel type
   *  into every reviewState consumer; the SpanReview surface narrows. */
  span_labels?: unknown[];
  task_kind?: "phenotype" | "ner";
  /** NER-only: note IDs the reviewer has marked validated for this
   *  patient × task. Defaults to empty (nothing validated). */
  validated_notes?: string[];
}

/** Cross-pane navigation: jump-to-source signal from ReviewForm → NoteViewer. */
export interface NoteFocus {
  filename: string;
  highlight?: { start: number; end: number };
}

export type ServerEvent =
  | { type: "connected"; message: string }
  | { type: "history"; patientId: string; messages: ChatMessage[] }
  | { type: "user_message"; patientId: string; content: string }
  | { type: "assistant_message"; patientId: string; content: string }
  | { type: "tool_use"; patientId: string; toolName: string; toolInput: unknown }
  | {
      type: "result";
      patientId: string;
      success: boolean;
      cost?: number;
      duration?: number;
    }
  | { type: "review_state_update"; patientId: string; state: ReviewState }
  | { type: "error"; patientId: string; error: string };

// ----- Phase B contract additions -----

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

export type CrossCriterionAlertKind =
  | "applicability_violation"
  | "derivation_violation"
  | "answer_consistency";

export interface CrossCriterionAlert {
  id: string;
  kind: CrossCriterionAlertKind;
  fields: string[];
  severity: "error" | "warning";
  message: string;
  computed_at: string;
  /** client-side tag merged from review_record vs review_state */
  source?: "static" | "live";
}

/** "adjudication" = legacy 3-pane (criteria + criterion + notes + bottom chat drawer)
 *  "conversation" = chat-first
 *  "unified"     = #34 — left chat-copilot rail + right adjudication workspace.
 *                  Keeps AdjudicationLayout intact on the right; the chat is a
 *                  permanent companion instead of a collapsible bottom drawer. */
export type LayoutMode = "adjudication" | "conversation" | "unified";

/** New audit step_type values (see spec §5.2) */
export type NewAuditStepType =
  | "accept_agent_draft"
  | "bulk_accept"
  | "record_validated"
  | "blind_submit"
  | "reviewer_session_summary";

/** Compiled task field definition (mirrors server task compiler output). */
export interface CompiledField {
  id: string;
  prompt?: string;
  group?: string;
  derivation?: string;
  is_applicable_when?: string;
  is_final_output?: boolean;
  answer_schema?: Record<string, unknown>;
  requires_calibration?: boolean;
  /** Short instruction (~one sentence) the methodologist gives the agent. */
  extraction_guidance?: string;
  /** Free-form prose sections from the criterion YAML (definition, examples,
   *  conflict_resolution, …). Keys are dynamic — render whatever's present. */
  guidance_prose?: Record<string, string>;
  /** "one" / "many" — how many answers a single criterion expects. */
  cardinality?: string;
  /** Named time window (e.g. "lookback_24mo") referenced by the task. */
  time_window?: string;
  /** Cross-references to keyword_sets/ and edge_cases/ in the guideline pack. */
  uses?: {
    keyword_sets?: string[];
    edge_cases?: string[];
  };
}

export interface CompiledTask {
  task_id: string;
  review_unit: "patient" | "encounter" | "episode" | "event";
  manual_version: string;
  source_document_sha: string;
  fields: CompiledField[];
  stratify_by?: string[];
}

export interface CriterionStats {
  total: number;
  reviewer_touched: number;
  override_count: number;
  override_rate: number;
  override_reasons: Record<string, number>;
  sparkline: number[];
  kappa?: number;
  kappa_reviewers?: [string, string];
  kappa_n_shared?: number;
  confusion?: Record<string, Record<string, number>>;
}

export interface QADriftAlert {
  field_id: string;
  baseline_rate: number;
  current_rate: number;
  delta_pp: number;
  triggered_at: string;
}

export interface QAStats {
  task_id: string;
  total_records: number;
  records_locked: number;
  records_validated: number;
  records_in_progress: number;
  by_criterion: Record<string, CriterionStats>;
  drift_alerts: QADriftAlert[];
}

// ----- Methodologist viewer types -----

export interface MethodologistResponse {
  task: { task_id: string; fields: CompiledField[] };
  qa: QAStats;
  sample_record_ids: string[];
}

export interface MethodologistRecordResponse {
  review_state: ReviewState;
  audit_summary: Array<{ ts: string; step_type: string; reviewer_id?: string }>;
}

export interface ViewerTokenInfo {
  token: string;
  task_id: string;
  expires_at: string;
  issued_by: string;
  issued_at: string;
}

// ----- Batch D-A: multi-reviewer + stratified sampling -----

export interface StratumGroup {
  key: Record<string, unknown>;
  patient_ids: string[];
}

export interface SamplingResult {
  total_eligible: number;
  strata: StratumGroup[];
  sampled: string[];
  skipped: Array<{ patient_id: string; reason: string }>;
}

export interface QueueEntry {
  task_id: string;
  patient_id: string;
  review_status: string;
  assigned_at: string;
}

// ----- Batch D-B: version history + diff types -----

export interface VersionEntry {
  task_id: string;
  lock_task_sha: string;
  archived_at: string;
  record_count: number;
  task_version?: string;
}

export interface FieldDiff {
  field_id: string;
  status: "added" | "removed" | "changed" | "unchanged";
  changes?: Array<{ key: string; from: unknown; to: unknown }>;
}

export interface TaskDiff {
  from_sha: string;
  to_sha: string;
  fields: FieldDiff[];
  global_changes: Array<{ key: string; from: unknown; to: unknown }>;
}

export interface ImpactResult {
  total_locked: number;
  total_unlocked: number;
  affected: Array<{ patient_id: string; review_status: string; intersect_fields: string[] }>;
  unaffected: string[];
  changed_field_ids: string[];
}

// Batch E.8a additions — rule proposals
export type RuleStatus =
  | "draft"
  | "pending_methodologist_review"
  | "applied"
  | "rejected"
  | "stale_after_v_next";

export type PatternStrength = "weak" | "moderate" | "strong";

export interface ProposedEdit {
  field_id: string;
  edit_type: "guidance_prose_append" | "is_applicable_when_replace";
  payload: string;
  rationale: string;
}

export interface ReplayFlip {
  record_id: string;
  change: string;
}

export interface RuleReplayResult {
  total_locked: number;
  flip_count: number;
  pattern_strength: PatternStrength;
  flips: ReplayFlip[];
  computed_at: string;
}

export interface RuleProposal {
  rule_id: string;
  task_id: string;
  field_id: string;
  status: RuleStatus;
  created_at: string;
  created_by: string;
  trigger?: {
    type: "override" | "standalone";
    patient_id?: string;
    agent_answer?: unknown;
    reviewer_answer?: unknown;
  };
  nl_rule: string;
  proposed_edit?: ProposedEdit;
  expected_outcome?: Array<{ record_id: string; expected_change: string; reasoning?: string }>;
  replay?: RuleReplayResult;
  replay_grading?: Array<{ text: string; passed: boolean; evidence: string }>;
  llm_sample_replay?: {
    sample_size: number;
    results: Array<{ record_id: string; matches: boolean; old_answer: unknown; new_answer: unknown }>;
    computed_at: string;
  };
  applied?: {
    applied_at: string;
    applied_by: string;
    resulting_sha: string;
    methodologist_edit?: ProposedEdit;
  };
  /** #44 — populated when a methodologist rejects via the reject endpoint. */
  rejected?: {
    rejected_at: string;
    rejected_by: string;
    reason: "duplicate" | "too_narrow" | "too_broad" | "wrong_field" | "low_quality" | "other";
    comment?: string;
  };
  stale_after_v_next?: { promoted_sha: string; auto_retranslated: boolean };
}
