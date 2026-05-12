/**
 * Stop-rule: the pilot loop is "ready to lock" when the last two complete
 * iters each landed with ZERO applied proposals.
 *
 * "Applied" means status === "applied" in the proposal store; rejected,
 * draft, or pending proposals don't count — the methodologist still found
 * something but didn't act on it, which is signal that the loop isn't
 * settled.
 */
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { guidelineDir } from "@chart-review/rubric";
import { PLATFORM_ROOT } from "@chart-review/patients";

export interface StopRuleReport {
  task_id: string;
  ready_to_lock: boolean;
  reason: string;
  applied_per_iter: Array<{ iter_id: string; applied_count: number }>;
  computed_at: string;
}

interface IterWindow { iter_id: string; started_at: string; completed_at: string }

function proposalsDir(taskId: string): string {
  const root = process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT;
  return path.join(root, "proposals", taskId);
}

function listCompleteIters(taskId: string): IterWindow[] {
  const pilotsDir = path.join(guidelineDir(taskId), "pilots");
  if (!fs.existsSync(pilotsDir)) return [];
  const out: IterWindow[] = [];
  for (const entry of fs.readdirSync(pilotsDir).sort()) {
    const manifestPath = path.join(pilotsDir, entry, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        iter_id?: string; state?: string; started_at?: string; completed_at?: string;
      };
      if (m.state === "complete" && m.started_at && m.completed_at) {
        out.push({ iter_id: m.iter_id ?? entry, started_at: m.started_at, completed_at: m.completed_at });
      }
    } catch { /* skip */ }
  }
  return out;
}

function countAppliedInWindow(taskId: string, start: string, end: string): number {
  const dir = proposalsDir(taskId);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
    try {
      const proposal = parseYaml(fs.readFileSync(path.join(dir, f), "utf8")) as {
        status?: string; applied?: { applied_at?: string };
      };
      const ts = proposal.applied?.applied_at;
      if (proposal.status === "applied" && ts && ts >= start && ts <= end) n += 1;
    } catch { /* skip */ }
  }
  return n;
}

export function evaluateStopRule(args: { taskId: string }): StopRuleReport {
  const iters = listCompleteIters(args.taskId);
  if (iters.length < 2) {
    return {
      task_id: args.taskId,
      ready_to_lock: false,
      reason: `Need at least two complete iters (have ${iters.length}).`,
      applied_per_iter: iters.map((i) => ({
        iter_id: i.iter_id,
        applied_count: countAppliedInWindow(args.taskId, i.started_at, i.completed_at),
      })),
      computed_at: new Date().toISOString(),
    };
  }
  const lastTwo = iters.slice(-2);
  const counts = lastTwo.map((i) => ({
    iter_id: i.iter_id,
    applied_count: countAppliedInWindow(args.taskId, i.started_at, i.completed_at),
  }));
  const ready = counts.every((c) => c.applied_count === 0);
  return {
    task_id: args.taskId,
    ready_to_lock: ready,
    reason: ready
      ? "Last two consecutive iters each had zero applied proposals — guideline appears settled."
      : `Most recent iter had ${counts[counts.length - 1].applied_count} applied proposal(s); not yet two consecutive clean iters.`,
    applied_per_iter: counts,
    computed_at: new Date().toISOString(),
  };
}
