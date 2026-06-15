import { z } from "zod";

const AgentClassification = z.enum([
  "correct",
  "wrong_answer_clear_rule",
  "wrong_answer_gap_arguable",
  "right_answer_wrong_evidence",
  "missed_human_evidence",
  "validation_failed",
]);

const PairClassification = z.enum([
  "both_correct",
  "one_wrong",
  "both_wrong_same_way",
  "both_wrong_different_ways",
]);

const PerAgent = z.object({
  answer_match_human: z.boolean(),
  evidence_overlap_jaccard: z.number().min(0).max(1),
  notes_read_jaccard: z.number().min(0).max(1),
  human_evidence_seen_by_agent: z.boolean(),
  classification: AgentClassification,
  rationale_short: z.string().min(1),
});

export const DerivedAdjudicationSchema = z.object({
  patient_id: z.string().min(1),
  field_id: z.string().min(1),
  iter_id: z.string().min(1),
  agent_1: PerAgent,
  agent_2: PerAgent,
  pair: z.object({ classification: PairClassification }),
  gap_signal: z.object({
    candidate: z.boolean(),
    reason: z.string(),
    suggested_revision: z.string().nullable(),
  }),
  trajectory_features: z.object({
    notes_unique_to_agent_1: z.array(z.string()),
    notes_unique_to_agent_2: z.array(z.string()),
    notes_only_human_cited: z.array(z.string()),
  }),
  reviewer_comment: z.string().nullable(),
  classifier: z.object({
    model: z.enum(["claude-haiku-4-5", "claude-sonnet-4-6"]),
    ts: z.string(),
    cost_usd: z.number().min(0),
  }),
});

export type DerivedAdjudication = z.infer<typeof DerivedAdjudicationSchema>;
