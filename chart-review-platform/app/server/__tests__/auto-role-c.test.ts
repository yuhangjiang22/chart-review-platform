import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { shouldAutoRoleC } from "../auto-role-c";
import { appendAuditEntry } from "../audit-trail";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "auto-rc-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});
afterEach(() => {
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const TID = "t1";

function seedDriftAlert(pid: string, fieldId: string, ts: string) {
  appendAuditEntry(
    { patientId: pid, taskId: TID, sessionId: `s-${pid}` },
    {
      ts,
      session_id: `s-${pid}`,
      step_type: "drift_alert",
      field_id: fieldId,
      baseline_rate: 0.05,
      current_rate: 0.20,
      delta_pp: 15,
      reviewer_id: "system",
    } as never,
  );
}

function seedRoleCAutoRun(pid: string, fieldId: string, ts: string) {
  appendAuditEntry(
    { patientId: pid, taskId: TID, sessionId: `s-${pid}` },
    {
      ts,
      session_id: `s-${pid}`,
      step_type: "role_c_auto_run",
      field_id: fieldId,
      drift_alert_count: 3,
      triggered_by: "system",
    } as never,
  );
}

describe("shouldAutoRoleC", () => {
  it("returns false with only 2 drift_alerts", () => {
    seedDriftAlert("p1", "x", "2026-04-29T10:00:00Z");
    seedDriftAlert("p2", "x", "2026-04-29T11:00:00Z");
    expect(shouldAutoRoleC({ taskId: TID, reviewsRoot: TMP, fieldId: "x" })).toBe(false);
  });

  it("returns true with 3 drift_alerts within 24h", () => {
    const now = new Date();
    seedDriftAlert("p1", "x", new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString());
    seedDriftAlert("p2", "x", new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString());
    seedDriftAlert("p3", "x", new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString());
    expect(shouldAutoRoleC({ taskId: TID, reviewsRoot: TMP, fieldId: "x" })).toBe(true);
  });

  it("returns false when one of the 3 is >24h old (window)", () => {
    seedDriftAlert("p1", "x", "2026-04-28T05:00:00Z");  // >24h before now
    seedDriftAlert("p2", "x", new Date().toISOString());
    seedDriftAlert("p3", "x", new Date().toISOString());
    expect(shouldAutoRoleC({ taskId: TID, reviewsRoot: TMP, fieldId: "x" })).toBe(false);
  });

  it("returns false within cooldown after a recent role_c_auto_run", () => {
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      seedDriftAlert(`p${i}`, "x", new Date(now.getTime() - i * 1000 * 60).toISOString());
    }
    seedRoleCAutoRun("system", "x", new Date(now.getTime() - 60 * 60 * 1000).toISOString());  // 1h ago
    expect(shouldAutoRoleC({ taskId: TID, reviewsRoot: TMP, fieldId: "x" })).toBe(false);
  });
});
