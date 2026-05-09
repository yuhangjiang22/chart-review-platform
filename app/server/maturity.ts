/**
 * Guideline maturity lifecycle.
 *
 *   draft  →  piloted  →  calibrated  →  locked
 *
 * - draft       authored, no pilot iteration completed yet
 * - piloted     ≥1 pilot iteration completed; ready to calibrate
 * - calibrated  human-vs-human κ checks pass; ready to lock
 * - locked      methodologist freezes the guideline; further edits
 *               require explicit unlock (back to a prior state)
 *
 * The state lives at `guidelines/<task_id>/maturity.json` and is NOT
 * part of the guideline package itself (i.e. it does NOT participate
 * in computeTaskSha) — maturity is workflow metadata, not definition.
 *
 * Transitions are recorded as an append-only history so we can
 * reconstruct who moved which task between states and why.
 */

import fs from "fs";
import path from "path";
import { guidelineDir } from "./domain/rubric/index.js";
import { listLockTests } from "./lock-test.js";
import { computeTaskSha } from "./lock.js";

export type MaturityState = "draft" | "piloted" | "calibrated" | "locked";

export const MATURITY_STATES: MaturityState[] = ["draft", "piloted", "calibrated", "locked"];

export interface MaturityTransition {
  from: MaturityState;
  to: MaturityState;
  ts: string;
  by: string;
  reason?: string;
}

export interface MaturityRecord {
  task_id: string;
  state: MaturityState;
  transitions: MaturityTransition[];
  /** When true, /api/reviews/:pid/:tid responses hide other reviewers'
   *  field_assessments from non-methodologists (#29). Used during
   *  calibration to prevent reviewers peeking at each other's locks. */
  calibration_blinded?: boolean;
}

function maturityPath(taskId: string): string {
  return path.join(guidelineDir(taskId), "maturity.json");
}

/**
 * Read the maturity record. If no file exists yet (the typical case
 * for a freshly-promoted guideline), defaults to "draft" with an
 * empty history. Callers can rely on always getting a valid record.
 */
export function getMaturity(taskId: string): MaturityRecord {
  const p = maturityPath(taskId);
  if (!fs.existsSync(p)) {
    return { task_id: taskId, state: "draft", transitions: [] };
  }
  try {
    const r = JSON.parse(fs.readFileSync(p, "utf8")) as MaturityRecord;
    if (!MATURITY_STATES.includes(r.state)) {
      return { task_id: taskId, state: "draft", transitions: [] };
    }
    return r;
  } catch {
    return { task_id: taskId, state: "draft", transitions: [] };
  }
}

/**
 * Transition the guideline to a new maturity state. Both forward and
 * backward (rollback / unlock) transitions are allowed — the only
 * restriction is no-op self-transitions are rejected. Backward
 * transitions require an explicit reason; the API enforces it.
 */
export function transitionMaturity(
  taskId: string,
  to: MaturityState,
  by: string,
  reason?: string,
): MaturityRecord {
  const cur = getMaturity(taskId);
  if (cur.state === to) {
    throw new Error(`already ${to}`);
  }
  const fromIdx = MATURITY_STATES.indexOf(cur.state);
  const toIdx = MATURITY_STATES.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) {
    throw new Error(`invalid state(s): ${cur.state} → ${to}`);
  }
  if (toIdx < fromIdx && !reason) {
    throw new Error(`backward transition (${cur.state} → ${to}) requires a reason`);
  }

  if (cur.state === "calibrated" && to === "locked") {
    const currentSha = computeTaskSha(guidelineDir(taskId));
    const passed = listLockTests(taskId).some(
      (lt) => lt.state === "passed" && lt.guideline_sha === currentSha,
    );
    if (!passed) {
      throw new Error(
        `Cannot transition to locked: no passed lock test exists for current guideline sha ${currentSha.slice(0, 8)}.`,
      );
    }
  }

  const updated: MaturityRecord = {
    ...cur,
    task_id: taskId,
    state: to,
    transitions: [
      ...cur.transitions,
      { from: cur.state, to, ts: new Date().toISOString(), by, ...(reason && { reason }) },
    ],
  };
  fs.mkdirSync(path.dirname(maturityPath(taskId)), { recursive: true });
  fs.writeFileSync(maturityPath(taskId), JSON.stringify(updated, null, 2));
  return updated;
}

/** Toggle calibration_blinded. Methodologist-driven (caller enforces). */
export function setCalibrationBlinded(taskId: string, blinded: boolean): MaturityRecord {
  const cur = getMaturity(taskId);
  const updated: MaturityRecord = { ...cur, calibration_blinded: blinded };
  fs.mkdirSync(path.dirname(maturityPath(taskId)), { recursive: true });
  fs.writeFileSync(maturityPath(taskId), JSON.stringify(updated, null, 2));
  return updated;
}
