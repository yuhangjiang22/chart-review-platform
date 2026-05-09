/** Canonical lifecycle phase. Mirror of server-side IterPhase in pilots.ts.
 *  UI must consume this field — don't switch on `state` + `auto_critique_state`
 *  + `run_status` independently. */
export type IterPhase =
  | "running"
  | "awaiting_validation"
  | "critiquing"
  | "complete"
  | "failed"
  | "abandoned";

export interface PilotListing {
  iter_id: string;
  iter_num: number;
  state: string;
  /** Computed server-side from manifest + run_status. Older PilotListings
   *  written before this field landed may not have it; UI falls back to
   *  switching on `state` for those. New listings always have `phase`. */
  phase?: IterPhase;
  run_status: string | null;
  n_complete: number;
  n_patients: number;
  notes?: string;
  started_at: string;
  started_by: string;
  critique?: {
    ran_at: string;
    proposal_count: number;
    error?: string;
    /** Full per-criterion accuracy block — populated by T5 critique flow. */
    accuracy?: {
      per_criterion: Array<{ field_id: string; accuracy: number | null; n_evaluable: number; n_correct: number }>;
      worst_accuracy: { field_id: string; accuracy: number } | null;
      avg_accuracy: number | null;
      override_count: number;
    } | null;
  } | null;
  auto_critique_state?: "running" | "failed";
  /** Refinement-loop addition (T7): per-iter accuracy summary, populated when
   *  the iter's critique.json has an accuracy block. */
  accuracy_summary?: {
    worst: { field_id: string; accuracy: number } | null;
    avg: number | null;
    override_count: number;
  } | null;
}

export interface EligibilityResult {
  eligible: boolean;
  consecutive_passing: number;
  required_consecutive: number;
  failing_criteria: Array<{ field_id: string; accuracy: number | null; iter_id: string }>;
  override_growth: number;
}
