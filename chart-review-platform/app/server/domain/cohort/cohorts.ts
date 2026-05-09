/**
 * Cohort manifest + run management for deployment-stage validation.
 *
 * A cohort is a named set of patients that a locked guideline is run against
 * to produce a publishable agreement (κ) number. Cohort metadata lives at:
 *
 *   cohorts/<cohort_id>/manifest.json
 *
 * Actual run artifacts remain under the default runs/<run_id>/ layout for
 * simplicity (plan §G.1 option b). The run manifest records cohort_id so
 * runs can be filtered by cohort without duplicating the pipeline.
 *
 * Sample selections are persisted at:
 *   cohorts/<cohort_id>/sample/selections/<run_id>.json
 */

import fs from "fs";
import path from "path";
import { PLATFORM_ROOT, PATIENTS_ROOT } from "../../patients.js";
import { loadCompiledTask } from "../../tasks.js";
import { computeTaskSha } from "../../lock.js";
import { guidelineDir } from "../rubric/index.js";
import {
  startBatchRun,
  listRuns,
  type RunManifest,
  type StartBatchRunOptions,
  type StartBatchRunResult,
} from "../../infra/batch-run/index.js";

// ── interfaces ────────────────────────────────────────────────────────────────

export interface CohortManifest {
  cohort_id: string;
  task_id: string;
  guideline_sha: string;
  patient_ids: string[];
  created_at: string;
  created_by: string;
  inclusion_criteria_text?: string;
  notes?: string;
}

export interface CohortRunManifest extends RunManifest {
  cohort_id: string;
  kind: "cohort_batch_run";
}

// ── layout helpers ────────────────────────────────────────────────────────────

export function cohortsRoot(): string {
  return process.env.CHART_REVIEW_COHORTS_ROOT ?? path.join(PLATFORM_ROOT, "cohorts");
}

export function cohortDir(cohortId: string): string {
  return path.join(cohortsRoot(), cohortId);
}

export function cohortManifestPath(cohortId: string): string {
  return path.join(cohortDir(cohortId), "manifest.json");
}

/** Convenience path for runs linked to a cohort (JSON pointer only — actual
 *  run data stays under runs/<run_id>/). */
export function cohortRunDir(cohortId: string, runId: string): string {
  return path.join(cohortDir(cohortId), "runs", runId);
}

// ── validation helpers ────────────────────────────────────────────────────────

function validateCohortId(cohortId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(cohortId)) {
    throw new Error(`invalid cohort_id "${cohortId}": only letters, digits, underscores, hyphens allowed`);
  }
}

function patientsRoot(): string {
  // Read dynamically so tests can override env vars after module import.
  const corpusRoot =
    process.env.CHART_REVIEW_CORPUS_ROOT ??
    path.join(
      process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT,
      "corpus",
    );
  return path.join(corpusRoot, "patients");
}

function validatePatientIds(patientIds: string[]): void {
  if (!Array.isArray(patientIds) || patientIds.length === 0) {
    throw new Error("patient_ids must be a non-empty array");
  }
  const root = patientsRoot();
  const missing: string[] = [];
  for (const pid of patientIds) {
    const candidate = path.resolve(root, pid);
    if (!fs.existsSync(candidate)) {
      missing.push(pid);
    }
  }
  if (missing.length > 0) {
    throw new Error(`unknown patient_ids: ${missing.join(", ")}`);
  }
}

// ── write operations ──────────────────────────────────────────────────────────

export interface DefineCohortOptions {
  cohort_id: string;
  task_id: string;
  patient_ids: string[];
  created_by: string;
  inclusion_criteria_text?: string;
  notes?: string;
}

/**
 * Register a cohort. Validates task_id and patient_ids, then writes
 * cohorts/<cohort_id>/manifest.json.
 *
 * Throws if:
 * - task_id not found
 * - any patient_id doesn't exist in the corpus
 * - cohort_id already exists
 */
export function defineCohort(opts: DefineCohortOptions): CohortManifest {
  validateCohortId(opts.cohort_id);

  const task = loadCompiledTask(opts.task_id);
  if (!task) {
    throw new Error(`task_id "${opts.task_id}" not found`);
  }

  validatePatientIds(opts.patient_ids);

  const manifestPath = cohortManifestPath(opts.cohort_id);
  if (fs.existsSync(manifestPath)) {
    throw new Error(`cohort "${opts.cohort_id}" already exists`);
  }

  const guidelineSha = computeTaskSha(guidelineDir(opts.task_id));

  const manifest: CohortManifest = {
    cohort_id: opts.cohort_id,
    task_id: opts.task_id,
    guideline_sha: guidelineSha,
    patient_ids: opts.patient_ids,
    created_at: new Date().toISOString(),
    created_by: opts.created_by,
    ...(opts.inclusion_criteria_text ? { inclusion_criteria_text: opts.inclusion_criteria_text } : {}),
    ...(opts.notes ? { notes: opts.notes } : {}),
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return manifest;
}

// ── read operations ───────────────────────────────────────────────────────────

export function listCohorts(): CohortManifest[] {
  const root = cohortsRoot();
  if (!fs.existsSync(root)) return [];
  const out: CohortManifest[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const p = cohortManifestPath(name);
    if (!fs.existsSync(p)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(p, "utf8")) as CohortManifest);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function getCohortManifest(cohortId: string): CohortManifest | null {
  const p = cohortManifestPath(cohortId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as CohortManifest;
  } catch {
    return null;
  }
}

/**
 * List all runs that belong to a cohort by scanning runs/ for manifests
 * that have cohort_id set to this cohort.
 */
export function listCohortRuns(cohortId: string): Array<{ run_id: string; task_id: string; started_at: string }> {
  const all = listRuns();
  return all
    .filter((r) => {
      // We need the full manifest to check cohort_id
      const manifestFile = path.join(
        process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(PLATFORM_ROOT, "runs"),
        r.run_id,
        "manifest.json",
      );
      if (!fs.existsSync(manifestFile)) return false;
      try {
        const m = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { cohort_id?: string };
        return m.cohort_id === cohortId;
      } catch {
        return false;
      }
    })
    .map((r) => ({
      run_id: r.run_id,
      task_id: r.task_id,
      started_at: r.started_at,
    }));
}

// ── cohort run ────────────────────────────────────────────────────────────────

export interface StartCohortRunOptions {
  started_by: string;
  label?: string;
  max_concurrency?: number;
  max_turns_per_patient?: number;
  cost_cap_usd?: number;
  patient_ids?: string[];  // subset; defaults to all cohort patients
}

/**
 * Start a batch run for this cohort. Uses startBatchRun under the hood;
 * threads cohort_id into the run manifest so listCohortRuns can find it.
 *
 * Run outputs land under the default runs/<run_id>/ layout (plan §G.1 option b).
 */
export function startCohortRun(
  cohortId: string,
  opts: StartCohortRunOptions,
): StartBatchRunResult {
  const manifest = getCohortManifest(cohortId);
  if (!manifest) {
    throw new Error(`cohort "${cohortId}" not found`);
  }

  const patientIds = opts.patient_ids ?? manifest.patient_ids;
  if (patientIds.length === 0) {
    throw new Error("patient_ids must be non-empty");
  }
  // Ensure all requested patients are in the cohort
  const cohortSet = new Set(manifest.patient_ids);
  const outside = patientIds.filter((p) => !cohortSet.has(p));
  if (outside.length > 0) {
    throw new Error(`patient_ids not in cohort: ${outside.join(", ")}`);
  }

  const batchOpts: StartBatchRunOptions & { cohort_id?: string } = {
    task_id: manifest.task_id,
    patient_ids: patientIds,
    started_by: opts.started_by,
    label: opts.label,
    max_concurrency: opts.max_concurrency,
    max_turns_per_patient: opts.max_turns_per_patient,
    cost_cap_usd: opts.cost_cap_usd,
    cohort_id: cohortId,
  };

  return startBatchRun(batchOpts);
}
