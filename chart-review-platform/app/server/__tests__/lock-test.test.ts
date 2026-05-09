import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { startLockTest, readLockTestManifest, listLockTests, finalizeLockTest } from "../lock-test.js";

describe("lock-test", () => {
  let tmp: string;
  let prevPlatformRoot: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lt-"));
    prevPlatformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
    process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevPlatformRoot === undefined) {
      delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    } else {
      process.env.CHART_REVIEW_PLATFORM_ROOT = prevPlatformRoot;
    }
  });

  it("startLockTest writes a manifest with state=running and copilot_blind_mode=true", () => {
    // Skill layout: .claude/skills/chart-review-t1/
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "chart-review-t1"), { recursive: true });
    const r = startLockTest({
      taskId: "t1",
      startedBy: "test_pi",
      guidelineSha: "abc12345",
    });
    const m = readLockTestManifest("t1", r.run_id);
    expect(m).toMatchObject({
      task_id: "t1",
      run_id: r.run_id,
      state: "running",
      copilot_blind_mode: true,
      guideline_sha: "abc12345",
      started_by: "test_pi",
    });
  });

  it("listLockTests returns runs newest-first", async () => {
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "chart-review-t1"), { recursive: true });
    const a = startLockTest({ taskId: "t1", startedBy: "u", guidelineSha: "x" });
    // Bump time so run_ids differ deterministically.
    await new Promise((r) => setTimeout(r, 5));
    const b = startLockTest({ taskId: "t1", startedBy: "u", guidelineSha: "x" });
    const runs = listLockTests("t1");
    expect(runs.length).toBe(2);
    expect(runs[0].run_id >= runs[1].run_id).toBe(true);
  });

  it("finalizeLockTest sets state=passed when every primary criterion ≥ 0.9", () => {
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "chart-review-t1"), { recursive: true });
    const m = startLockTest({ taskId: "t1", startedBy: "u", guidelineSha: "x" });
    const acc = {
      task_id: "t1", iter_id: m.run_id, cohort_kind: "lock" as const,
      patient_ids: ["p1"],
      per_criterion: [
        { field_id: "f1", n_evaluable: 1, n_correct: 1, accuracy: 1.0 },
        { field_id: "f2", n_evaluable: 1, n_correct: 1, accuracy: 0.95 },
      ],
      worst_accuracy: { field_id: "f2", accuracy: 0.95 },
      avg_accuracy: 0.975,
      override_count: 0,
      computed_at: "2026-05-02T00:00:00.000Z",
    };
    const result = finalizeLockTest({ taskId: "t1", runId: m.run_id, accuracy: acc });
    expect(result.state).toBe("passed");
    expect(readLockTestManifest("t1", m.run_id)!.state).toBe("passed");
    const skillDir = path.join(tmp, ".claude", "skills", "chart-review-t1");
    expect(fs.existsSync(path.join(skillDir, "lock_test", m.run_id, "report.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, "lock_test", m.run_id, "accuracy.json"))).toBe(true);
  });

  it("finalizeLockTest sets state=failed when any primary criterion < 0.9", () => {
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "chart-review-t1"), { recursive: true });
    const m = startLockTest({ taskId: "t1", startedBy: "u", guidelineSha: "x" });
    const acc = {
      task_id: "t1", iter_id: m.run_id, cohort_kind: "lock" as const,
      patient_ids: ["p1"],
      per_criterion: [
        { field_id: "f1", n_evaluable: 1, n_correct: 1, accuracy: 1.0 },
        { field_id: "f2", n_evaluable: 1, n_correct: 0, accuracy: 0.86 },
      ],
      worst_accuracy: { field_id: "f2", accuracy: 0.86 },
      avg_accuracy: 0.93,
      override_count: 0,
      computed_at: "2026-05-02T00:00:00.000Z",
    };
    const result = finalizeLockTest({ taskId: "t1", runId: m.run_id, accuracy: acc });
    expect(result.state).toBe("failed");
    expect(result.failure_reason).toMatch(/f2/);
  });
});
