// Mirrors app/server/deployment-issues.ts. Keep in sync.

export type TriageCategory = "dismiss" | "agent_error" | "data_issue" | "guideline_gap";

export interface TriageState {
  category: TriageCategory;
  triaged_by: string;
  triaged_at: string;
  note?: string;
  corrected_answer?: unknown;
}

export interface PromotionState {
  promoted_to_iter: string;
  promoted_at: string;
  promoted_by: string;
}

export interface DeploymentIssue {
  issue_id: string;
  guideline_sha: string;
  patient_id: string;
  field_id?: string;
  reporter_id: string;
  reported_at: string;
  description: string;
  suggested_correction?: unknown;
  triage?: TriageState;
  promoted?: PromotionState;
}

export interface PromoteResponse {
  iter_id: string;
  run_id: string;
  n_patients_promoted: number;
  n_issues_promoted: number;
  rejected?: Array<{ issue_id: string; reason: string }>;
}

/** A triage category is "promotable" if folding the issue into a new pilot
 *  iter is meaningful — agent failures and guideline ambiguities, not data
 *  noise or dismissed items. */
export const PROMOTABLE_CATEGORIES: ReadonlySet<TriageCategory> = new Set([
  "agent_error",
  "guideline_gap",
]);

export interface IssuesResponse {
  guideline_sha: string;
  issues: DeploymentIssue[];
  n_total: number;
}

/** Display labels for the four triage categories. */
export const TRIAGE_LABELS: Record<TriageCategory, string> = {
  dismiss: "Dismiss",
  agent_error: "Agent error",
  data_issue: "Data issue",
  guideline_gap: "Guideline gap",
};

/** Visual treatment per category — uses the palette's editorial variants:
 *  ochre (warning) for actionable agent failures and guideline ambiguity,
 *  outline for environmental noise, pending (muted) for dismissed. */
export const TRIAGE_VARIANTS: Record<TriageCategory, "warning" | "overridden" | "outline" | "pending"> = {
  agent_error: "warning",
  guideline_gap: "overridden",
  data_issue: "outline",
  dismiss: "pending",
};
