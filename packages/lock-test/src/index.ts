import fs from "fs";
import path from "path";
import { guidelineDir } from "@chart-review/rubric";

export type LockTestState = "running" | "passed" | "failed" | "abandoned";

export interface LockTestManifest {
  task_id: string;
  run_id: string;            // ISO timestamp with `:` and `.` → `-` (filesystem-safe)
  guideline_sha: string;
  started_at: string;
  started_by: string;
  state: LockTestState;
  copilot_blind_mode: true;  // always true; enforced platform-side
  agent_run_id?: string;     // populated when the agent batch-run kicks off (T10)
  completed_at?: string;
  failure_reason?: string;   // populated when state === "failed" (T9)
}

function lockTestRoot(taskId: string): string {
  return path.join(guidelineDir(taskId), "lock_test");
}

function lockTestRunDir(taskId: string, runId: string): string {
  return path.join(lockTestRoot(taskId), runId);
}

function manifestPath(taskId: string, runId: string): string {
  return path.join(lockTestRunDir(taskId, runId), "manifest.json");
}

function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function startLockTest(args: {
  taskId: string;
  startedBy: string;
  guidelineSha: string;
}): LockTestManifest {
  const runId = newRunId();
  const m: LockTestManifest = {
    task_id: args.taskId,
    run_id: runId,
    guideline_sha: args.guidelineSha,
    started_at: new Date().toISOString(),
    started_by: args.startedBy,
    state: "running",
    copilot_blind_mode: true,
  };
  const dir = lockTestRunDir(args.taskId, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(args.taskId, runId), JSON.stringify(m, null, 2));
  return m;
}

export function readLockTestManifest(taskId: string, runId: string): LockTestManifest | null {
  const p = manifestPath(taskId, runId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as LockTestManifest;
}

export function writeLockTestManifest(taskId: string, m: LockTestManifest): void {
  fs.writeFileSync(manifestPath(taskId, m.run_id), JSON.stringify(m, null, 2));
}

export function listLockTests(taskId: string): LockTestManifest[] {
  const root = lockTestRoot(taskId);
  if (!fs.existsSync(root)) return [];
  const runs: LockTestManifest[] = [];
  for (const d of fs.readdirSync(root)) {
    const m = readLockTestManifest(taskId, d);
    if (m) runs.push(m);
  }
  return runs.sort((a, b) => b.run_id.localeCompare(a.run_id));
}

// _internal exports lockTestRunDir for T9's finalizeLockTest to write accuracy.json and report.md
export const _internal = { lockTestRunDir };

import type { IterAccuracy } from "@chart-review/domain-iter";

const LOCK_THRESHOLD = 0.9;

export function finalizeLockTest(args: {
  taskId: string;
  runId: string;
  accuracy: IterAccuracy;
}): LockTestManifest {
  const m = readLockTestManifest(args.taskId, args.runId);
  if (!m) throw new Error(`no manifest for lock_test/${args.runId}`);

  const dir = lockTestRunDir(args.taskId, args.runId);
  fs.writeFileSync(path.join(dir, "accuracy.json"), JSON.stringify(args.accuracy, null, 2));

  const failing = args.accuracy.per_criterion.filter(
    (c) => c.accuracy == null || c.accuracy < LOCK_THRESHOLD,
  );
  const passed = failing.length === 0;
  const updated: LockTestManifest = {
    ...m,
    state: passed ? "passed" : "failed",
    completed_at: new Date().toISOString(),
    ...(passed
      ? {}
      : { failure_reason: `criteria below ${LOCK_THRESHOLD}: ${failing.map((c) => c.field_id).join(", ")}` }),
  };
  writeLockTestManifest(args.taskId, updated);

  // Markdown report
  const lines: string[] = [
    `# Lock test ${args.runId} — ${args.taskId}`,
    "",
    `Cohort: LOCK · n=${args.accuracy.patient_ids.length}`,
    `Guideline sha: \`${m.guideline_sha}\``,
    `Copilot blind mode: ${m.copilot_blind_mode}`,
    `Started: ${m.started_at} by ${m.started_by}`,
    "",
    "## Per-criterion accuracy",
    "",
    "| criterion | n | accuracy |",
    "|-----------|---|----------|",
  ];
  for (const c of args.accuracy.per_criterion) {
    lines.push(`| \`${c.field_id}\` | ${c.n_evaluable} | ${c.accuracy?.toFixed(2) ?? "—"} |`);
  }
  lines.push("");
  lines.push(`**Verdict:** ${passed ? "PASSED" : "FAILED"}`);
  if (!passed) lines.push(`Failing criteria: ${failing.map((c) => `\`${c.field_id}\``).join(", ")}`);
  fs.writeFileSync(path.join(dir, "report.md"), lines.join("\n") + "\n");

  return updated;
}
