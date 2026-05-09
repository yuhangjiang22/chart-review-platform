// app/server/drift-detector.ts
import fs from "fs";
import path from "path";

const DRIFT_WINDOW = 50;
const DRIFT_THRESHOLD_PP = 10;
const DRIFT_COOLDOWN_MS = 30 * 60 * 1000;
const MIN_WINDOW_FILL = 25;

export interface DriftCheckInput {
  taskId: string;
  changedFieldId: string;
  reviewsRoot: string;
}

export interface DriftAlert {
  field_id: string;
  baseline_rate: number;
  current_rate: number;
  delta_pp: number;
}

interface FieldRecord {
  ts: string;
  override: boolean;
}

export function checkDrift(input: DriftCheckInput): DriftAlert | null {
  const { taskId, changedFieldId, reviewsRoot } = input;
  const records = collectFieldRecords(reviewsRoot, taskId, changedFieldId);
  if (records.length < MIN_WINDOW_FILL * 2) return null;

  // Sort desc by ts
  records.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const current = records.slice(0, DRIFT_WINDOW);
  const baseline = records.slice(DRIFT_WINDOW, DRIFT_WINDOW * 2);
  if (current.length < MIN_WINDOW_FILL || baseline.length < MIN_WINDOW_FILL) return null;

  const cur_rate = current.filter((r) => r.override).length / current.length;
  const base_rate = baseline.filter((r) => r.override).length / baseline.length;
  const delta_pp = Math.abs(cur_rate - base_rate) * 100;

  if (delta_pp < DRIFT_THRESHOLD_PP) return null;

  // Cooldown — read recent audit entries for this (task, field) and skip if a drift_alert was emitted within DRIFT_COOLDOWN_MS
  if (recentDriftAlertExists(reviewsRoot, taskId, changedFieldId)) return null;

  return {
    field_id: changedFieldId,
    baseline_rate: base_rate,
    current_rate: cur_rate,
    delta_pp,
  };
}

function collectFieldRecords(reviewsRoot: string, taskId: string, fieldId: string): FieldRecord[] {
  const out: FieldRecord[] = [];
  if (!fs.existsSync(reviewsRoot)) return out;
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
    if (!fs.existsSync(rsPath)) continue;
    try {
      const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
        field_assessments?: Array<{ field_id: string; status?: string; source?: string; updated_at?: string }>;
      };
      const fa = rs.field_assessments?.find((f) => f.field_id === fieldId && f.source === "reviewer");
      if (fa?.updated_at) {
        out.push({ ts: fa.updated_at, override: fa.status === "overridden" });
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

function recentDriftAlertExists(reviewsRoot: string, taskId: string, fieldId: string): boolean {
  if (!fs.existsSync(reviewsRoot)) return false;
  const cutoff = Date.now() - DRIFT_COOLDOWN_MS;
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const chatDir = path.join(reviewsRoot, pid, taskId, "chat");
    if (!fs.existsSync(chatDir)) continue;
    for (const f of fs.readdirSync(chatDir)) {
      const lines = fs.readFileSync(path.join(chatDir, f), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.step_type === "drift_alert" && entry.field_id === fieldId) {
            const tsMs = new Date(entry.ts).getTime();
            if (tsMs >= cutoff) return true;
          }
        } catch {
          // skip
        }
      }
    }
  }
  return false;
}
