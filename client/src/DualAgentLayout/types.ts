// app/client/src/DualAgentLayout/types.ts
export interface AgentDraft {
  agent_id: string;
  patient_id: string;
  field_assessments: FieldAssessment[];
}

export interface FieldAssessment {
  field_id: string;
  answer: string;
  evidence: EvidenceRef[];
  confidence?: "low" | "medium" | "high";
  rationale?: string;
}

export interface EvidenceRef {
  note_id: string;
  quote: string;
  offsets: [number, number];
}

export type DisagreementKind = "hard" | "soft";

export interface Disagreement {
  patient_id: string;
  field_id: string;
  kind: DisagreementKind;
  pair: { agent_a: string; agent_b: string };
  answers: { agent_a: string; agent_b: string };
  evidence: { agent_a: EvidenceRef[]; agent_b: EvidenceRef[] };
}

export type AdjudicationClassification =
  | "guideline_gap"
  | "agent_a_error"
  | "agent_b_error"
  | "true_clinical_ambiguity";

export interface Adjudication {
  patient_id: string;
  field_id: string;
  pair: { agent_a: string; agent_b: string };
  classification: AdjudicationClassification;
  suggested_revision?: string;
  reviewer: string;
  timestamp: string;
  notes?: string;
}
