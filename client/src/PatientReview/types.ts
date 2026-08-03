export interface PerAgentDerived {
  answer_match_human: boolean;
  evidence_overlap_jaccard: number;
  notes_read_jaccard: number;
  human_evidence_seen_by_agent: boolean;
  classification:
    | "correct"
    | "wrong_answer_clear_rule"
    | "wrong_answer_gap_arguable"
    | "right_answer_wrong_evidence"
    | "missed_human_evidence"
    | "validation_failed";
  rationale_short: string;
}

export interface DerivedAdjudication {
  patient_id: string;
  field_id: string;
  iter_id: string;
  agent_1: PerAgentDerived;
  agent_2: PerAgentDerived;
  pair: { classification: "both_correct" | "one_wrong" | "both_wrong_same_way" | "both_wrong_different_ways" };
  gap_signal: { candidate: boolean; reason: string; suggested_revision: string | null };
  trajectory_features: {
    notes_unique_to_agent_1: string[];
    notes_unique_to_agent_2: string[];
    notes_only_human_cited: string[];
  };
  reviewer_comment: string | null;
  classifier: { model: "claude-haiku-4-5" | "claude-sonnet-4-6"; ts: string; cost_usd: number };
}
