/**
 * Cohort sample validation — server-side helpers for G.3.
 *
 * When a stratified sample is drawn, each patient enters a "pending validation"
 * state. This module provides:
 *
 * 1. Layout helpers for the validation filesystem tree:
 *      cohorts/<cohort_id>/sample/validations/<patient_id>/review_state.json
 *
 * 2. Validation-status helpers that inspect the reviewer's review_state to
 *    compute how many leaf criteria have been answered.
 *
 * 3. Sample-queue helpers that join selection data with per-patient status.
 *
 * 4. Blinding support: when cohort.blind=true and a patient isn't fully
 *    validated, agent draft answers are stripped before returning to the client.
 *
 * The review_state.json shape is identical to the one in
 * reviews/<patient_id>/<task_id>/review_state.json so the existing MCP
 * set_field_assessment tool can write to it via withReviewsRoot.
 */

import fs from "fs";
import path from "path";
import type { ReviewState, FieldAssessment } from "@chart-review/domain-review";
import { cohortsRoot } from "./cohorts.js";
import type { AgentDraft } from "@chart-review/disagreements";
import { writeJsonAtomic } from "@chart-review/fs-atomic";

// ── layout ────────────────────────────────────────────────────────────────────

export function cohortValidationsDir(cohortId: string): string {
  return path.join(cohortsRoot(), cohortId, "sample", "validations");
}

export function cohortValidationPatientDir(cohortId: string, patientId: string): string {
  return path.join(cohortValidationsDir(cohortId), patientId);
}

export function cohortValidationStatePath(cohortId: string, patientId: string): string {
  return path.join(cohortValidationPatientDir(cohortId, patientId), "review_state.json");
}

/**
 * The root path passed to withReviewsRoot so MCP review-state writes for a
 * cohort validation invocation land under the cohort directory tree.
 *
 * review-state.ts uses: reviewsRoot() + "/" + patientId + "/" + taskId + "/review_state.json"
 * We want:              cohortValidationsDir(cohortId) + "/" + patientId + "/" + taskId + "/review_state.json"
 *
 * So the override root is cohortValidationsDir(cohortId).
 */
export function cohortValidationReviewsRoot(cohortId: string): string {
  return cohortValidationsDir(cohortId);
}

// ── selection helpers ─────────────────────────────────────────────────────────

export interface SampleSelection {
  strategy: {
    n_total: number;
    stratify_by: string;
    balance: "equal" | "proportional";
    seed: number;
  };
  selected: string[];
  rationale: string;
  drawn_at: string;
  drawn_by: string;
}

export function readSelection(cohortId: string, runId: string): SampleSelection | null {
  const p = path.join(cohortsRoot(), cohortId, "sample", "selections", `${runId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as SampleSelection;
  } catch {
    return null;
  }
}

// ── validation state I/O ─────────────────────────────────────────────────────

/**
 * Read the reviewer's current review_state for a patient.
 *
 * The path used here matches how withReviewsRoot redirects MCP writes:
 *   cohortValidationsDir(cohortId)/<patientId>/<taskId>/review_state.json
 */
export function readValidationState(
  cohortId: string,
  patientId: string,
  taskId: string,
): ReviewState | null {
  const p = path.join(cohortValidationsDir(cohortId), patientId, taskId, "review_state.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ReviewState;
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) the reviewer's review_state for a cohort validation
 * patient. Used as the fallback REST path; canonical write path is MCP.
 */
export function writeValidationState(
  cohortId: string,
  patientId: string,
  taskId: string,
  state: ReviewState,
): void {
  const dir = path.join(cohortValidationsDir(cohortId), patientId, taskId);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, "review_state.json"), state);
}

// ── status computation ────────────────────────────────────────────────────────

export type ValidationStatus = "pending" | "in_progress" | "validated";

export interface PatientValidationStatus {
  patient_id: string;
  status: ValidationStatus;
  n_answered: number;
  n_leaf_criteria: number;
}

/**
 * Count how many leaf-level criteria the reviewer has answered.
 *
 * We consider a field "answered" if it has at least one FieldAssessment with
 * source="reviewer" and a non-null answer. This is a simple heuristic; the
 * full-fidelity count would require loading the task schema. For the queue
 * display we use the count from the agent draft's field_assessments as the
 * denominator, falling back to the reviewer state's own assessments.
 */
export function computeValidationStatus(
  reviewState: ReviewState | null,
  agentDraft: AgentDraft | null,
): { status: ValidationStatus; n_answered: number; n_leaf_criteria: number } {
  const reviewerAnswers = (reviewState?.field_assessments ?? []).filter(
    (f) => f.source === "reviewer" && f.answer !== undefined && f.answer !== null,
  );
  const n_answered = reviewerAnswers.length;

  // Use the agent's field list as the denominator if available; otherwise fall
  // back to the reviewer state or 0.
  const agentFields = agentDraft?.field_assessments ?? [];
  const reviewerFields = reviewState?.field_assessments ?? [];
  const n_leaf_criteria = agentFields.length > 0
    ? agentFields.length
    : reviewerFields.length;

  let status: ValidationStatus;
  if (n_answered === 0) {
    status = "pending";
  } else if (n_leaf_criteria > 0 && n_answered >= n_leaf_criteria) {
    status = "validated";
  } else {
    status = "in_progress";
  }

  return { status, n_answered, n_leaf_criteria };
}

// ── blinding ──────────────────────────────────────────────────────────────────

/**
 * Strip agent answers from a draft when blind mode is active and the reviewer
 * hasn't yet committed answers for all leaf criteria.
 *
 * Returns the draft with answer/evidence/rationale/confidence nulled out on
 * each FieldAssessment, plus a top-level `blinded: true` marker.
 */
export function blindDraft(draft: AgentDraft): AgentDraft & { blinded: true } {
  return {
    ...draft,
    blinded: true,
    field_assessments: draft.field_assessments.map((f) => ({
      ...f,
      answer: undefined,
      evidence: undefined,
      rationale: undefined,
      confidence: undefined,
    })),
  };
}

/**
 * Read the agent draft for a cohort run patient.
 *
 * Drafts are stored at runs/<run_id>/per_patient/<pid>/agent_draft.json
 * (plan §G.1 option b — runs stay in the default location).
 */
export function readCohortAgentDraft(
  runsRoot: string,
  runId: string,
  patientId: string,
): AgentDraft | null {
  const draftPath = path.join(runsRoot, runId, "per_patient", patientId, "agent_draft.json");
  if (!fs.existsSync(draftPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    return {
      agent_id: "agent_1",
      patient_id: patientId,
      field_assessments: Array.isArray(raw.field_assessments) ? raw.field_assessments : [],
    } as AgentDraft;
  } catch {
    return null;
  }
}

// ── sample queue ──────────────────────────────────────────────────────────────

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

/**
 * Build the sample queue for a given cohort run.
 *
 * Loads the selection, then for each selected patient reads:
 * - The agent draft (from the run's per_patient dir)
 * - The reviewer's validation state (from the cohort's validations dir)
 *
 * Returns a structured response including overall counters.
 */
export function buildSampleQueue(
  cohortId: string,
  runId: string,
  taskId: string,
  runsRoot: string,
): SampleQueueResponse | null {
  const selection = readSelection(cohortId, runId);
  if (!selection) return null;

  const patients: SampleQueueEntry[] = [];
  for (const pid of selection.selected) {
    const agentDraft = readCohortAgentDraft(runsRoot, runId, pid);
    const reviewState = readValidationState(cohortId, pid, taskId);
    const { status, n_answered, n_leaf_criteria } = computeValidationStatus(reviewState, agentDraft);
    patients.push({ patient_id: pid, validation_status: status, n_answered, n_leaf_criteria });
  }

  const n_validated = patients.filter((p) => p.validation_status === "validated").length;

  return {
    cohort_id: cohortId,
    run_id: runId,
    drawn_at: selection.drawn_at,
    drawn_by: selection.drawn_by,
    n_total: patients.length,
    n_validated,
    patients,
  };
}
