import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reconcileOrphanedRunsOnStartup,
  getRunStatus,
  statusPath,
  runDir,
  type RunStatus,
} from "./runs.js";

// reconcileOrphanedRunsOnStartup reads/writes under runsRoot(), which honors
// CHART_REVIEW_RUNS_ROOT. Point it at a throwaway dir per test.
let root: string;
let prevEnv: string | undefined;

function writeStatus(runId: string, status: RunStatus): void {
  fs.mkdirSync(runDir(runId), { recursive: true });
  fs.writeFileSync(statusPath(runId), JSON.stringify(status, null, 2));
}

function baseStatus(runId: string, over: Partial<RunStatus> = {}): RunStatus {
  return {
    run_id: runId,
    state: "running",
    started_at: "2026-06-15T19:50:08.795Z",
    updated_at: "2026-06-15T19:50:08.797Z",
    completed_at: null,
    total_cost_usd: 0,
    n_patients: 1,
    n_complete: 0,
    n_error: 0,
    n_running: 1,
    per_patient: { p1: { state: "running", started_at: "2026-06-15T19:50:08.797Z" } },
    ...over,
  };
}

const NOW = new Date("2026-06-15T20:00:00.000Z");

beforeEach(() => {
  prevEnv = process.env.CHART_REVIEW_RUNS_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  process.env.CHART_REVIEW_RUNS_ROOT = root;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.CHART_REVIEW_RUNS_ROOT;
  else process.env.CHART_REVIEW_RUNS_ROOT = prevEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("reconcileOrphanedRunsOnStartup", () => {
  it("flips a stuck single-patient running run to failed and errors the in-flight patient", () => {
    writeStatus("run_a", baseStatus("run_a"));

    const reconciled = reconcileOrphanedRunsOnStartup(NOW);
    expect(reconciled).toEqual(["run_a"]);

    const s = getRunStatus("run_a")!;
    expect(s.state).toBe("failed");
    expect(s.n_running).toBe(0);
    expect(s.n_error).toBe(1);
    expect(s.n_complete).toBe(0);
    expect(s.completed_at).toBe(NOW.toISOString());
    expect(s.per_patient.p1.state).toBe("error");
    expect(s.per_patient.p1.error).toMatch(/orphaned/i);
  });

  it("preserves completed patients — a partially-done run becomes complete_with_errors", () => {
    writeStatus(
      "run_b",
      baseStatus("run_b", {
        n_patients: 2,
        per_patient: {
          done: { state: "complete", completed_at: "2026-06-15T19:51:00Z", cost_usd: 0.01 },
          stuck: { state: "running", started_at: "2026-06-15T19:51:00Z" },
        },
      }),
    );

    reconcileOrphanedRunsOnStartup(NOW);

    const s = getRunStatus("run_b")!;
    expect(s.state).toBe("complete_with_errors");
    expect(s.n_complete).toBe(1);
    expect(s.n_error).toBe(1);
    // The completed patient is untouched (draft + metadata preserved).
    expect(s.per_patient.done).toEqual({
      state: "complete",
      completed_at: "2026-06-15T19:51:00Z",
      cost_usd: 0.01,
    });
    expect(s.per_patient.stuck.state).toBe("error");
  });

  it("marks a run complete when every patient finished but the finalize write was lost", () => {
    writeStatus(
      "run_c",
      baseStatus("run_c", {
        per_patient: { p1: { state: "complete", completed_at: "2026-06-15T19:51:00Z" } },
      }),
    );

    reconcileOrphanedRunsOnStartup(NOW);

    const s = getRunStatus("run_c")!;
    expect(s.state).toBe("complete");
    expect(s.n_complete).toBe(1);
    expect(s.n_error).toBe(0);
  });

  it("leaves already-terminal runs untouched and skips _scratch dirs", () => {
    writeStatus("run_done", baseStatus("run_done", { state: "complete", n_running: 0, n_complete: 1 }));
    // a _scratch_state_* sibling dir must be ignored by the directory walk
    fs.mkdirSync(path.join(root, "_scratch_state_agent_1"), { recursive: true });

    const reconciled = reconcileOrphanedRunsOnStartup(NOW);
    expect(reconciled).toEqual([]);
    expect(getRunStatus("run_done")!.state).toBe("complete");
  });

  it("returns an empty list when the runs root does not exist", () => {
    fs.rmSync(root, { recursive: true, force: true });
    expect(reconcileOrphanedRunsOnStartup(NOW)).toEqual([]);
  });
});

// ── owner liveness ────────────────────────────────────────────────────────
// A "running" run at boot is only a phantom when its OWNING PROCESS is gone.
// Standalone drivers (scripts/*-realtest/run.ts) survive server restarts, and
// reaping one destroys live work — five LCN/asthma runs were lost that way
// before this guard existed (2026-08-27).
describe("reconcileOrphanedRunsOnStartup — owner liveness", () => {
  it("does NOT reap a run whose owner process is alive and beating", () => {
    writeStatus(
      "run_live",
      baseStatus("run_live", {
        owner_pid: process.pid, // this test process is, definitionally, alive
        heartbeat_at: new Date(NOW.getTime() - 5_000).toISOString(),
      }),
    );

    expect(reconcileOrphanedRunsOnStartup(NOW)).toEqual([]);
    const s = getRunStatus("run_live")!;
    expect(s.state).toBe("running");
    expect(s.per_patient.p1.state).toBe("running");
  });

  it("reaps a run whose owner pid is gone", () => {
    // pid 2^22 is above the default pid_max on macOS/Linux, so it cannot exist
    writeStatus(
      "run_dead",
      baseStatus("run_dead", {
        owner_pid: 4194304,
        heartbeat_at: new Date(NOW.getTime() - 5_000).toISOString(),
      }),
    );

    expect(reconcileOrphanedRunsOnStartup(NOW)).toEqual(["run_dead"]);
    expect(getRunStatus("run_dead")!.state).toBe("failed");
  });

  it("reaps a live pid whose heartbeat is stale (guards against pid reuse)", () => {
    writeStatus(
      "run_stale",
      baseStatus("run_stale", {
        owner_pid: process.pid,
        heartbeat_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      }),
    );

    expect(reconcileOrphanedRunsOnStartup(NOW)).toEqual(["run_stale"]);
    expect(getRunStatus("run_stale")!.state).toBe("failed");
  });

  it("still reaps legacy runs that carry no owner_pid", () => {
    writeStatus("run_legacy", baseStatus("run_legacy"));
    expect(reconcileOrphanedRunsOnStartup(NOW)).toEqual(["run_legacy"]);
    expect(getRunStatus("run_legacy")!.state).toBe("failed");
  });
});
