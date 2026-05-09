// app/server/qa-panel.ts
import fs from "fs";
import path from "path";
import { readAuditEntries } from "./audit-trail.js";
import { replayReviewerAnswers, computeKappaProper } from "./kappa.js";

export interface CriterionStats {
  total: number;
  reviewer_touched: number;
  override_count: number;
  override_rate: number;
  override_reasons: Record<string, number>;
  sparkline: number[];
  kappa?: number;
  kappa_reviewers?: [string, string];
  kappa_n_shared?: number;
  confusion?: Record<string, Record<string, number>>;
}

export interface DriftAlert {
  field_id: string;
  baseline_rate: number;
  current_rate: number;
  delta_pp: number;
  triggered_at: string;
}

export interface QAStats {
  task_id: string;
  total_records: number;
  records_locked: number;
  records_validated: number;
  records_in_progress: number;
  by_criterion: Record<string, CriterionStats>;
  drift_alerts: DriftAlert[];
}

interface MinimalAssessment {
  field_id: string;
  answer?: unknown;
  status?: string;
  source?: string;
  updated_by?: string;
  updated_at?: string;
  edit_reason?: string;
}

interface MinimalState {
  patient_id?: string;
  review_status?: string;
  field_assessments?: MinimalAssessment[];
}

export async function computeQAStats(
  taskId: string,
  reviewsRoot: string,
): Promise<QAStats> {
  const stats: QAStats = {
    task_id: taskId,
    total_records: 0,
    records_locked: 0,
    records_validated: 0,
    records_in_progress: 0,
    by_criterion: {},
    drift_alerts: [],
  };
  if (!fs.existsSync(reviewsRoot)) return stats;

  // Walk reviews/<*>/<taskId>/review_state.json — skip _* directories
  const allRecords: Array<{ pid: string; state: MinimalState }> = [];
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
    if (!fs.existsSync(rsPath)) continue;
    try {
      const state = JSON.parse(
        fs.readFileSync(rsPath, "utf8"),
      ) as MinimalState;
      allRecords.push({ pid, state });
    } catch {
      // skip malformed files
    }
  }

  stats.total_records = allRecords.length;
  for (const { state } of allRecords) {
    if (state.review_status === "locked") stats.records_locked++;
    else if (state.review_status === "reviewer_validated")
      stats.records_validated++;
    else if (state.review_status === "in_progress") stats.records_in_progress++;
  }

  // Per-criterion aggregation
  const byCrit: Record<
    string,
    { records: Array<{ pid: string; fa: MinimalAssessment }> }
  > = {};
  for (const { pid, state } of allRecords) {
    for (const fa of state.field_assessments ?? []) {
      if (!byCrit[fa.field_id]) byCrit[fa.field_id] = { records: [] };
      byCrit[fa.field_id].records.push({ pid, fa });
    }
  }

  for (const [fieldId, { records }] of Object.entries(byCrit)) {
    const reviewerRecs = records.filter((r) => r.fa.source === "reviewer");
    const overrides = reviewerRecs.filter(
      (r) => r.fa.status === "overridden",
    );

    // Tally override reasons
    const reasons: Record<string, number> = {};
    for (const r of overrides) {
      const reason = r.fa.edit_reason ?? "unspecified";
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }

    // Sparkline: sort reviewer records by updated_at descending, take last 100,
    // bin into up to 5 chunks of 20 and compute per-bin override rate.
    const sorted = [...reviewerRecs]
      .sort((a, b) =>
        (b.fa.updated_at ?? "") < (a.fa.updated_at ?? "") ? -1 : 1,
      )
      .slice(0, 100);
    const sparkline: number[] = [];
    for (let i = 0; i < 5; i++) {
      const chunk = sorted.slice(i * 20, (i + 1) * 20);
      if (chunk.length === 0) continue;
      sparkline.push(
        chunk.filter((c) => c.fa.status === "overridden").length /
          chunk.length,
      );
    }

    stats.by_criterion[fieldId] = {
      total: records.length,
      reviewer_touched: reviewerRecs.length,
      override_count: overrides.length,
      override_rate:
        reviewerRecs.length > 0
          ? overrides.length / reviewerRecs.length
          : 0,
      override_reasons: reasons,
      sparkline,
    };

    const replayed = replayReviewerAnswers(reviewsRoot, taskId, fieldId);
    const kappaResult = computeKappaProper(replayed);
    if (kappaResult) {
      Object.assign(stats.by_criterion[fieldId], kappaResult);
    }
  }

  // Collect drift alerts — most recent entry per field from audit logs
  stats.drift_alerts = collectDriftAlerts(reviewsRoot, taskId);

  return stats;
}

function collectDriftAlerts(
  reviewsRoot: string,
  taskId: string,
): DriftAlert[] {
  const byField: Record<string, DriftAlert> = {};
  if (!fs.existsSync(reviewsRoot)) return [];

  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const chatDir = path.join(reviewsRoot, pid, taskId, "chat");
    if (!fs.existsSync(chatDir)) continue;
    for (const f of fs.readdirSync(chatDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const sessionId = f.replace(/\.jsonl$/, "");
      const entries = readAuditEntries({ patientId: pid, taskId, sessionId });
      for (const e of entries) {
        if (e.step_type !== "drift_alert") continue;
        const det = e as {
          step_type: "drift_alert";
          field_id: string;
          baseline_rate: number;
          current_rate: number;
          delta_pp: number;
          ts: string;
        };
        const existing = byField[det.field_id];
        if (!existing || det.ts > existing.triggered_at) {
          byField[det.field_id] = {
            field_id: det.field_id,
            baseline_rate: det.baseline_rate,
            current_rate: det.current_rate,
            delta_pp: det.delta_pp,
            triggered_at: det.ts,
          };
        }
      }
    }
  }

  return Object.values(byField);
}
