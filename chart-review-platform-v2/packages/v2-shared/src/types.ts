// Module contracts for chart-review-platform-v2.
//
// Where shapes already exist in v1 we re-export them verbatim so a v1
// FieldAssessment IS a v2 FieldAssessment. Only the cross-module
// glue (TaskSpec, FormSpec wrapper, the module interfaces) is new.

// ── Shapes inherited from v1 ────────────────────────────────────────
export type {
  EvidenceRef,
  FieldAssessment,
  AgentDraft,
  AgentAnswerSlot,
  Disagreement,
  DisagreementKind,
  DisagreementSummary,
} from "@chart-review/disagreements";

// v1's CompiledField is what form-gen emits as a Criterion.
export type { CompiledField, CompiledTask } from "@chart-review/tasks";

// v1's agent-provider abstraction (Claude / Codex / per-run dropdown)
// IS our ExtractModule's underlying runner.
export type { ProviderName, AgentRunInput, AgentEvent, AgentProvider }
  from "@chart-review/agent-provider";

// v1's audit-trail union — v2's correct-log module writes these.
export type { AuditEntry as V1AuditEntry, AuditCoordinates }
  from "@chart-review/audit-trail";

// ── v2-specific wrappers ────────────────────────────────────────────

import type { CompiledField } from "@chart-review/tasks";
import type {
  FieldAssessment, EvidenceRef, DisagreementSummary,
} from "@chart-review/disagreements";

/** Alias for v1's CompiledField — that's our Criterion. The MVP keeps
 *  the v2 name visible so module-level docs read naturally. */
export type Criterion = CompiledField;

export interface TaskSpec {
  task_id: string;
  domain: Domain;
  scope: unknown;
  rigor_tier?: "rapid" | "lite" | "full";
  created_at: string;
  created_by: string;
}

export type Domain = "chart-review" | "lit-extract";

/** v2 wrapper: pairs v1's CompiledField list with a top-level
 *  schema_hash for carry-forward across iterations. */
export interface FormSpec {
  task_id: string;
  schema_hash: string;
  criteria: CompiledField[];
}

export interface SubjectRef {
  type: "patient" | "paper";
  id: string;
}

export interface EvidenceUnit {
  unit_id: string;
  subject_id: string;
  source_type: "note" | "abstract" | "fulltext";
  text: string;
  meta: Record<string, unknown>;
}

export interface ExtractorOutput {
  extractor_id: string;
  task_id: string;
  subject_id: string;
  cells: FieldAssessment[];
}

/** Per-cell categorization the reconciler emits. Hard / soft come
 *  from v1's DisagreementKind; the others are v2 additions. */
export type ReconciliationOutcome =
  | "agreed"
  | "disagreed_hard"
  | "disagreed_soft"
  | "low_confidence"
  | "type_drift";

export interface JudgeAnalysis {
  suggested_answer: unknown;
  reasoning: string;
  confidence: "low" | "medium" | "high";
  /** Optional: pointers the judge wants the human to look at. */
  evidence_pointers?: EvidenceRef[];
}

export interface ReconciledDraft {
  task_id: string;
  subject_id: string;
  summary: DisagreementSummary;
  cells: ReconciledCell[];
}

export interface ReconciledCell {
  field_id: string;
  extractor_inputs: {
    extractor_id: string;
    answer: unknown;
    confidence: "low" | "medium" | "high";
    evidence: EvidenceRef[];
  }[];
  reconciliation: ReconciliationOutcome;
  judge?: JudgeAnalysis;
  status: "auto_resolved" | "needs_human";
}

export interface FinalizedAssessment {
  task_id: string;
  subject_id: string;
  cells: FinalizedCell[];
  audit_log: AuditEntry[];
}

export interface FinalizedCell {
  field_id: string;
  answer: unknown;
  confidence: "low" | "medium" | "high";
  evidence: EvidenceRef[];
  rationale: string;
  source: "agent" | "judge" | "human";
  override_of_agent: boolean;
  edit_reason?: EditReason;
  edit_note?: string;
}

export type EditReason =
  | "missed_evidence" | "misinterpreted" | "wrong_rule"
  | "criterion_ambiguous" | "other";

export interface AuditEntry {
  ts: string;
  actor: string;
  action: "extract" | "judge" | "confirm" | "override";
  field_id: string;
  before?: unknown;
  after: unknown;
  reason?: string;
}

// ── Module interfaces (the plug-in seams) ───────────────────────────

export interface ClarifyModule {
  clarify(prompt: string, opts?: ClarifyOptions): Promise<TaskSpec>;
}
export interface ClarifyOptions {
  rigor_tier?: TaskSpec["rigor_tier"];
  user_id?: string;
}

export interface FormGenModule {
  generate(spec: TaskSpec): Promise<FormSpec>;
}

export interface DiscoverModule {
  discover(spec: TaskSpec, subject: SubjectRef): Promise<EvidenceUnit[]>;
}

export interface ExtractModule {
  extract(
    form: FormSpec,
    subject: SubjectRef,
    corpus: EvidenceUnit[],
    extractor_id: string,
  ): Promise<ExtractorOutput>;
}

export interface ValidateModule {
  reconcile(outputs: ExtractorOutput[], opts?: { runJudge?: boolean }): Promise<ReconciledDraft>;
}

export interface CorrectLogModule {
  recordDecision(
    task_id: string,
    subject_id: string,
    field_id: string,
    decision: HumanDecision,
  ): Promise<FinalizedAssessment>;
}

export interface HumanDecision {
  actor: string;
  action: "confirm" | "override";
  answer?: unknown;
  edit_reason?: EditReason;
  edit_note?: string;
}
