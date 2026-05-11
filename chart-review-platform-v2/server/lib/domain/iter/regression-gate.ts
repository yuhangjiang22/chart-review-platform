/**
 * Inter-iter regression gate.
 *
 * Before advancing to a new pilot iter, every patient that prior iters
 * locked in as ground truth must still produce the same answers under
 * the CURRENT guideline state. Any disagreement blocks the advance —
 * the methodologist must either revert the offending proposal or
 * promote the failing patient into the new iter (and re-validate
 * its truth, which may legitimately change).
 */
import * as fs from "fs";
import * as path from "path";
import { guidelineDir } from "../rubric/index.js";
import { PLATFORM_ROOT } from "../../patients.js";

export interface Regression {
  patient_id: string;
  field_id: string;
  was: unknown;
  now: unknown;
}

export interface RegressionGateReport {
  task_id: string;
  patients_checked: number;
  regressions: Regression[];
  gate: "clear" | "blocked";
  computed_at: string;
}

export interface CheckRegressionArgs {
  taskId: string;
  /** Iter ids to skip — typically the iter that's about to start, since its
   *  patients haven't been validated yet. */
  excludeIterIds: string[];
  /** Production wires this to the batch-run / criterion-rerun infra; tests
   *  inject a fake. Returns answers keyed by field_id. */
  reRunPatient: (taskId: string, patientId: string) => Promise<Record<string, unknown>>;
}

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

function listPriorPatients(taskId: string, excludeIterIds: string[]): string[] {
  const pilotsDir = path.join(guidelineDir(taskId), "pilots");
  if (!fs.existsSync(pilotsDir)) return [];
  const exclude = new Set(excludeIterIds);
  const patients = new Set<string>();
  for (const entry of fs.readdirSync(pilotsDir).sort()) {
    if (exclude.has(entry)) continue;
    const manifestPath = path.join(pilotsDir, entry, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { patient_ids?: string[] };
      for (const pid of m.patient_ids ?? []) patients.add(pid);
    } catch { /* skip malformed */ }
  }
  return [...patients];
}

function loadGroundTruth(taskId: string, patientId: string): Record<string, unknown> {
  const p = path.join(reviewsRoot(), patientId, taskId, "review_state.json");
  if (!fs.existsSync(p)) return {};
  const state = JSON.parse(fs.readFileSync(p, "utf8")) as {
    field_assessments?: Array<{ field_id: string; answer: unknown; source: string; status: string }>;
  };
  const out: Record<string, unknown> = {};
  for (const fa of state.field_assessments ?? []) {
    if (fa.source === "reviewer" && fa.status === "approved") out[fa.field_id] = fa.answer;
  }
  return out;
}

export async function checkRegression(args: CheckRegressionArgs): Promise<RegressionGateReport> {
  const patients = listPriorPatients(args.taskId, args.excludeIterIds);
  const regressions: Regression[] = [];

  for (const patient_id of patients) {
    const truth = loadGroundTruth(args.taskId, patient_id);
    const current = await args.reRunPatient(args.taskId, patient_id);
    for (const field_id of Object.keys(truth)) {
      if (current[field_id] !== truth[field_id]) {
        regressions.push({ patient_id, field_id, was: truth[field_id], now: current[field_id] });
      }
    }
  }

  return {
    task_id: args.taskId,
    patients_checked: patients.length,
    regressions,
    gate: regressions.length === 0 ? "clear" : "blocked",
    computed_at: new Date().toISOString(),
  };
}
