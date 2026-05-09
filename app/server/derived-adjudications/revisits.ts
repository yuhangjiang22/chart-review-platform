import fs from "fs";
import path from "path";
import { loadCompiledTask } from "../tasks.js";
import {
  getPilotManifest,
  snapshotCriterionHashesSync,
} from "../domain/iter/pilots.js";
import { runDir as computeRunDir } from "../infra/batch-run/index.js";
import { PLATFORM_ROOT } from "../patients.js";
import type { Evidence } from "../faithfulness.js";
import { writeJsonAtomic } from "../lib/fs-atomic.js";

export interface RevisitRow {
  field_id: string;
  field_prompt_current: string;
  patient_id: string;
  prior_answer: unknown;
  prior_evidence: Evidence[];
  prior_rationale: string | null;
  agent_rerun_answer: unknown | null;
  agent_rerun_rationale: string | null;
  prior_captured_hash: string | null;
  current_hash: string;
}

export interface RevisitsResult {
  rows: RevisitRow[];
  criteria_changed: number;
  total: number;
}

interface PerPatientReviewState {
  field_assessments?: Array<{
    field_id: string;
    source: string;
    answer?: unknown;
    evidence?: Evidence[];
    rationale?: string;
    captured_against_schema_hash?: string;
  }>;
}

interface AgentDraft {
  field_assessments?: Array<{
    field_id: string;
    answer?: unknown;
    rationale?: string;
  }>;
}

/**
 * Return the reviews root directory. Re-reads the env var each call so that
 * tests can override CHART_REVIEW_REVIEWS_ROOT without restarting the module.
 */
function reviewsRootPath(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "reviews");
}

function readReviewState(taskId: string, patientId: string): PerPatientReviewState | null {
  const fp = path.join(reviewsRootPath(), patientId, taskId, "review_state.json");
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function readAgentDraft(runDir: string, patientId: string, agentId: string): AgentDraft | null {
  const fp = path.join(runDir, "per_patient", patientId, "agents", `${agentId}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function listPatientsWithReviews(taskId: string): string[] {
  const root = reviewsRootPath();
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const patientId of fs.readdirSync(root)) {
    const taskDir = path.join(root, patientId, taskId);
    if (fs.existsSync(path.join(taskDir, "review_state.json"))) {
      out.push(patientId);
    }
  }
  return out;
}

export function computeRevisitsForIter(args: {
  taskId: string;
  iterId: string;
}): RevisitsResult {
  const { taskId, iterId } = args;
  const task = loadCompiledTask(taskId);
  if (!task) return { rows: [], criteria_changed: 0, total: 0 };

  const currentHashes = snapshotCriterionHashesSync(taskId);
  const fieldPrompts: Record<string, string> = {};
  for (const f of task.fields) fieldPrompts[f.id] = f.prompt ?? "";

  const manifest = getPilotManifest(taskId, iterId);
  const runDirAbs = manifest ? computeRunDir(manifest.run_id) : null;

  const patients = listPatientsWithReviews(taskId);
  const rows: RevisitRow[] = [];
  const changedFieldIds = new Set<string>();

  for (const patientId of patients) {
    const state = readReviewState(taskId, patientId);
    if (!state?.field_assessments) continue;
    const agentDraft = runDirAbs ? readAgentDraft(runDirAbs, patientId, "agent_1") : null;

    for (const fa of state.field_assessments) {
      const currentHash = currentHashes[fa.field_id];
      if (!currentHash) continue;                                // criterion deleted
      const captured = fa.captured_against_schema_hash ?? null;
      if (captured === currentHash) continue;                    // fresh
      // When we don't know the prior hash (assessment was written before
      // captured_against_schema_hash became a tracked field, or the snapshot
      // call silently failed), we cannot conclude the criterion has actually
      // changed. Treat it as fresh rather than reporting a false positive
      // that blocks the reviewer from locking. Truly-stale cells (where we
      // DO have a prior hash that differs from current) still surface below.
      if (captured === null) continue;
      changedFieldIds.add(fa.field_id);
      const draft = agentDraft?.field_assessments?.find((a) => a.field_id === fa.field_id);
      rows.push({
        field_id: fa.field_id,
        field_prompt_current: fieldPrompts[fa.field_id] ?? "",
        patient_id: patientId,
        prior_answer: fa.answer ?? null,
        prior_evidence: fa.evidence ?? [],
        prior_rationale: fa.rationale ?? null,
        agent_rerun_answer: draft?.answer ?? null,
        agent_rerun_rationale: draft?.rationale ?? null,
        prior_captured_hash: captured,
        current_hash: currentHash,
      });
    }
  }

  return { rows, criteria_changed: changedFieldIds.size, total: rows.length };
}

export interface BulkKeepArgs {
  taskId: string;
  fieldId: string;
  patientIds?: string[];        // when omitted, applies to every patient with a stale record
  reviewerId: string;
}

export interface BulkKeepResult {
  bumped: number;
}

export async function bulkKeepRevisits(args: BulkKeepArgs): Promise<BulkKeepResult> {
  const { taskId, fieldId, patientIds } = args;
  const currentHashes = snapshotCriterionHashesSync(taskId);
  const currentHash = currentHashes[fieldId];
  if (!currentHash) return { bumped: 0 };

  const candidates = patientIds ?? listPatientsWithReviews(taskId);
  let bumped = 0;
  for (const patientId of candidates) {
    const fp = path.join(reviewsRootPath(), patientId, taskId, "review_state.json");
    if (!fs.existsSync(fp)) continue;
    let state: PerPatientReviewState;
    try {
      state = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      continue;
    }
    const fa = state.field_assessments?.find((a) => a.field_id === fieldId);
    if (!fa) continue;
    if (fa.captured_against_schema_hash === currentHash) continue;   // already fresh
    fa.captured_against_schema_hash = currentHash;
    writeJsonAtomic(fp, state);
    bumped++;
  }
  return { bumped };
}
