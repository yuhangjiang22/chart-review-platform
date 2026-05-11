/**
 * Assignment helpers — assign / unassign reviewers to patient×task records,
 * and query a reviewer's work queue.
 *
 * All mutations go through applyUiAction("set_assigned_to") so they share the
 * same atomic-write + version-increment path as every other state mutation.
 * Audit entries (record_assigned / record_unassigned) are appended to the
 * session JSONL for the same record.
 */

import fs from "fs";
import path from "path";
import { applyUiAction, load as loadState, type ReviewState } from "./domain/review/index.js";
import { appendAuditEntry } from "./audit-trail.js";
import type { CompiledTask } from "./tasks.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AssignmentInput {
  taskId: string;
  patientIds: string[];
  reviewerIds: string[];
  reviewsRoot: string;
}

export interface QueueEntry {
  task_id: string;
  patient_id: string;
  review_status: string;
  assigned_at: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal CompiledTask shape sufficient for applyUiAction("set_assigned_to").
 * The set_assigned_to case only calls mutate() → recomputeLiveAlerts(task, s),
 * which iterates task.fields for derivation/applicability checks. With an empty
 * fields array, no alerts are emitted — fine for assignment writes.
 */
function minimalTask(taskId: string): CompiledTask {
  return { task_id: taskId, source_document_sha: "", fields: [] } as unknown as CompiledTask;
}

// ---------------------------------------------------------------------------
// assignRecords
// ---------------------------------------------------------------------------

/**
 * Add `reviewerIds` to the `assigned_to` list for every (patient, task) pair.
 * Idempotent: reviewers already present are silently skipped.
 */
export async function assignRecords(input: AssignmentInput, by: string): Promise<void> {
  const { taskId, patientIds, reviewerIds, reviewsRoot } = input;

  for (const pid of patientIds) {
    const state = loadState(pid, taskId);
    if (!state) continue;

    const existing = new Set(state.assigned_to ?? []);
    const added: string[] = [];
    for (const rid of reviewerIds) {
      if (!existing.has(rid)) {
        existing.add(rid);
        added.push(rid);
      }
    }
    if (added.length === 0) continue; // idempotent — nothing changed

    await applyUiAction(pid, minimalTask(taskId), "reviewer", by, {
      type: "set_assigned_to",
      payload: { assigned_to: [...existing], updated_by: by },
    });

    const sessionId = `assign-${Date.now()}`;
    const ts = new Date().toISOString();
    for (const rid of added) {
      appendAuditEntry(
        { patientId: pid, taskId, sessionId },
        {
          ts,
          session_id: sessionId,
          step_type: "record_assigned",
          patient_id: pid,
          reviewer_id: rid,
          assigned_by: by,
        },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// unassignRecords
// ---------------------------------------------------------------------------

/**
 * Remove `reviewerIds` from the `assigned_to` list for every (patient, task)
 * pair. Reviewers not currently assigned are silently skipped.
 */
export async function unassignRecords(input: AssignmentInput, by: string): Promise<void> {
  const { taskId, patientIds, reviewerIds, reviewsRoot } = input;
  const removeSet = new Set(reviewerIds);

  for (const pid of patientIds) {
    const state = loadState(pid, taskId);
    if (!state) continue;

    const existing = state.assigned_to ?? [];
    const removed = existing.filter((r) => removeSet.has(r));
    if (removed.length === 0) continue; // nothing to remove

    const remaining = existing.filter((r) => !removeSet.has(r));

    await applyUiAction(pid, minimalTask(taskId), "reviewer", by, {
      type: "set_assigned_to",
      payload: { assigned_to: remaining, updated_by: by },
    });

    const sessionId = `unassign-${Date.now()}`;
    const ts = new Date().toISOString();
    for (const rid of removed) {
      appendAuditEntry(
        { patientId: pid, taskId, sessionId },
        {
          ts,
          session_id: sessionId,
          step_type: "record_unassigned",
          patient_id: pid,
          reviewer_id: rid,
          unassigned_by: by,
        },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// getReviewerQueue
// ---------------------------------------------------------------------------

/**
 * Walk every patient×task directory under `reviewsRoot` and collect all
 * records where `reviewerId` appears in `assigned_to`.
 */
export function getReviewerQueue(reviewerId: string, reviewsRoot: string): QueueEntry[] {
  const out: QueueEntry[] = [];
  if (!fs.existsSync(reviewsRoot)) return out;

  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const patientDir = path.join(reviewsRoot, pid);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(patientDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const tid of fs.readdirSync(patientDir)) {
      const rsPath = path.join(patientDir, tid, "review_state.json");
      if (!fs.existsSync(rsPath)) continue;

      let rs: ReviewState;
      try {
        rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as ReviewState;
      } catch {
        continue;
      }

      if (rs.assigned_to && rs.assigned_to.includes(reviewerId)) {
        out.push({
          task_id: tid,
          patient_id: pid,
          review_status: rs.review_status ?? "draft",
          assigned_at: rs.updated_at,
        });
      }
    }
  }

  return out;
}
