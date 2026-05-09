import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { checkDrift } from "../drift-detector";
import { applyUiAction } from "../domain/review/index.js";
import { readAuditEntries } from "../audit-trail";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";

function writeReviewState(pid: string, fieldAssessments: Array<{ field_id: string; status: string; source: string; updated_at: string }>) {
  const dir = path.join(TMP, pid, TID);
  fs.mkdirSync(path.join(dir, "chat"), { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    schema_version: "1",
    patient_id: pid,
    task_id: TID,
    version: 1,
    updated_at: new Date().toISOString(),
    updated_by: "test",
    field_assessments: fieldAssessments,
  }));
}

describe("checkDrift", () => {
  it("returns null when fewer than 25 records in current window", () => {
    for (let i = 0; i < 20; i++) {
      writeReviewState(`p${i}`, [{ field_id: "x", status: "approved", source: "reviewer", updated_at: new Date(2026, 3, i + 1).toISOString() }]);
    }
    const result = checkDrift({ taskId: TID, changedFieldId: "x", reviewsRoot: TMP });
    expect(result).toBe(null);
  });

  it("returns null when delta is below threshold", () => {
    // 100 records, 5% override rate in both halves — no drift
    for (let i = 0; i < 100; i++) {
      const status = i % 20 === 0 ? "overridden" : "approved";
      writeReviewState(`p${i}`, [{ field_id: "x", status, source: "reviewer", updated_at: new Date(2026, 3, 1, 0, i).toISOString() }]);
    }
    const result = checkDrift({ taskId: TID, changedFieldId: "x", reviewsRoot: TMP });
    expect(result).toBe(null);
  });

  it("returns DriftAlert when current rate exceeds baseline by ≥10pp", () => {
    // 50 baseline records: 5% override
    for (let i = 0; i < 50; i++) {
      const status = i % 20 === 0 ? "overridden" : "approved";
      writeReviewState(`baseline_p${i}`, [{ field_id: "x", status, source: "reviewer", updated_at: new Date(2026, 3, 1, 0, i).toISOString() }]);
    }
    // 50 current records: 30% override
    for (let i = 0; i < 50; i++) {
      const status = i % 3 === 0 ? "overridden" : "approved";
      writeReviewState(`current_p${i}`, [{ field_id: "x", status, source: "reviewer", updated_at: new Date(2026, 4, 1, 0, i).toISOString() }]);
    }
    const result = checkDrift({ taskId: TID, changedFieldId: "x", reviewsRoot: TMP });
    expect(result).not.toBe(null);
    expect(result!.field_id).toBe("x");
    expect(result!.delta_pp).toBeGreaterThanOrEqual(10);
    expect(result!.baseline_rate).toBeCloseTo(0.05, 1);
    expect(result!.current_rate).toBeGreaterThan(0.25);
  });
});

describe("drift-detector wired into applyUiAction", () => {
  it("emits drift_alert audit entry on a write that crosses the threshold", async () => {
    const TID2 = "t2";
    const TASK = { task_id: TID2, source_document_sha: "sha", fields: [{ id: "x" }] };

    process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;

    // Seed 50 baseline records (5% override) under TID2
    for (let i = 0; i < 50; i++) {
      const status = i % 20 === 0 ? "overridden" : "approved";
      await applyUiAction(`baseline_p${i}`, TASK, "reviewer", "alice", {
        type: "set_field_assessment",
        payload: { field_id: "x", answer: "yes", status },
      });
    }

    // Now write 50 high-override records
    for (let i = 0; i < 50; i++) {
      const status = i % 3 === 0 ? "overridden" : "approved";
      await applyUiAction(`current_p${i}`, TASK, "reviewer", "alice", {
        type: "set_field_assessment",
        payload: { field_id: "x", answer: "yes", status },
      });
    }

    // Inspect audit logs for drift_alert
    const allEntries: any[] = [];
    for (const pid of fs.readdirSync(TMP)) {
      if (pid.startsWith("_")) continue;
      const sessionDir = path.join(TMP, pid, TID2, "chat");
      if (!fs.existsSync(sessionDir)) continue;
      for (const sid of fs.readdirSync(sessionDir)) {
        allEntries.push(...readAuditEntries({ patientId: pid, taskId: TID2, sessionId: sid.replace(".jsonl", "") }));
      }
    }
    const drift = allEntries.find((e) => e.step_type === "drift_alert" && e.field_id === "x");
    expect(drift).toBeDefined();
  });
});
