// Client-side type mirrors for the cohort validation (G.3) API.

export interface CohortManifest {
  cohort_id: string;
  task_id: string;
  guideline_sha: string;
  patient_ids: string[];
  created_at: string;
  created_by: string;
  inclusion_criteria_text?: string;
  notes?: string;
  /** Default true. When true the agent's draft answers are hidden until
   *  the reviewer has committed their own answers for all leaf criteria. */
  blind?: boolean;
}

export interface CohortRunListing {
  run_id: string;
  task_id: string;
  started_at: string;
}

export interface CohortDetailResponse {
  manifest: CohortManifest;
  runs: CohortRunListing[];
}

export type ValidationStatus = "pending" | "in_progress" | "validated";

export interface SampleQueueEntry {
  patient_id: string;
  validation_status: ValidationStatus;
  n_answered: number;
  n_leaf_criteria: number;
}

export interface SampleQueueResponse {
  cohort_id: string;
  run_id: string;
  drawn_at: string;
  drawn_by: string;
  n_total: number;
  n_validated: number;
  patients: SampleQueueEntry[];
}
