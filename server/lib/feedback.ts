/**
 * Role C — Cohort feedback driver.
 *
 * Drives the `chart-review-cohort` verb skill (.claude/skills/cohort-feedback/SKILL.md)
 * via composeAgentOptions. The skill walks every review_state.json for the
 * given guideline and emits a feedback report.
 *
 *   reviews/<pid>/<guideline-id>/review_state.json (across pids)
 *     →  cohorts/<guideline-id>/runs/<run_id>/feedback.{json,md}
 *
 * Each invocation is run-keyed so prior reports are preserved. The "current"
 * report is the lexicographically-largest run_id (run_ids are ISO timestamps).
 *
 * Same agent primitive as authoring.ts and guideline-improvement.ts; this driver
 * is a one-shot version pointed at a guideline that already has reviews.
 */

import fs from "fs";
import path from "path";
import { runAgent } from "./agent-provider.js";
import { PLATFORM_ROOT } from "./patients.js";
import { loadCompiledTask } from "./tasks.js";
import { guidelineDir } from "./domain/rubric/index.js";

const COHORTS_ROOT = path.join(PLATFORM_ROOT, "var", "cohorts");
const REVIEWS_ROOT = path.join(PLATFORM_ROOT, "var", "reviews");

export interface AnalyzeCohortOptions {
  task_id: string;
  member_ids?: string[]; // optional explicit cohort; otherwise every patient with state
}

export interface CohortAnalysisResult {
  ok: boolean;
  task_id: string;
  run_id?: string;
  cohort_dir?: string;
  feedback_path?: string;
  feedback?: unknown;
  member_count?: number;
  members?: string[];
  duration_ms: number;
  cost_usd?: number;
  error?: string;
}

export interface CohortRunListing {
  task_id: string;
  run_id: string;
  generated_at: string;
  member_count: number | null;
}

function findCohortMembers(taskId: string, hint?: string[]): string[] {
  if (hint && hint.length > 0) {
    return hint.filter((id) => /^[a-zA-Z0-9_-]+$/.test(id));
  }
  if (!fs.existsSync(REVIEWS_ROOT)) return [];
  const ids: string[] = [];
  for (const pid of fs.readdirSync(REVIEWS_ROOT)) {
    const p = path.join(REVIEWS_ROOT, pid, taskId, "review_state.json");
    if (fs.existsSync(p)) ids.push(pid);
  }
  return ids.sort();
}

export async function analyzeCohort(
  opts: AnalyzeCohortOptions,
): Promise<CohortAnalysisResult> {
  const startedAt = Date.now();

  // Verify the guideline exists
  const task = loadCompiledTask(opts.task_id);
  if (!task) {
    return {
      ok: false,
      task_id: opts.task_id,
      duration_ms: 0,
      error: `task ${opts.task_id} not found`,
    };
  }

  const members = findCohortMembers(opts.task_id, opts.member_ids);
  if (members.length === 0) {
    return {
      ok: false,
      task_id: opts.task_id,
      member_count: 0,
      members: [],
      duration_ms: 0,
      error:
        "no review_state.json found for any patient on this task — run a chat session first to populate state.",
    };
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(COHORTS_ROOT, opts.task_id, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });

  const guidelinePath = guidelineDir(opts.task_id);
  const memberPaths = members.map(
    (pid) => `reviews/${pid}/${opts.task_id}/review_state.json`,
  );
  const relRunDir = path.relative(PLATFORM_ROOT, runDir);

  const userPrompt = [
    `Use the \`cohort-feedback\` skill to analyze this cohort and emit a feedback report.`,
    "",
    `Guideline: ${opts.task_id}`,
    `Guideline path: ${path.relative(PLATFORM_ROOT, guidelinePath)}`,
    `Cohort size: ${members.length}`,
    `Run id: ${runId}`,
    `Output paths (write into the run directory):`,
    `  - ${relRunDir}/feedback.json`,
    `  - ${relRunDir}/feedback.md`,
    "",
    "## Cohort members",
    ...memberPaths.map((p, i) => `${i + 1}. ${members[i]} → ${p}`),
    "",
    "After writing both files, summarize the findings in 3-5 sentences.",
  ].join("\n");

  let cost: number | undefined;
  let success = false;
  let errorMessage: string | undefined;

  try {
    for await (const event of runAgent({
      prompt: userPrompt,
      cwd: PLATFORM_ROOT,
      taskId: opts.task_id,
      guidelinePath,
      extraTools: ["Write"],
      maxTurns: 50,
      permissionMode: "acceptEdits",
      extraSystemPrompt:
        "Activate the `chart-review-cohort` skill via the Skill tool. Follow its " +
        "procedure to walk every review_state.json for this guideline, detect " +
        "drift, cluster overrides, and emit feedback.json + feedback.md to " +
        "the output paths in the user message. Do NOT propose edits — that's " +
        "the `chart-review-improve` skill's job.",
    })) {
      if (event.type === "result") {
        // Per AgentEvent docs: subtype is Anthropic-specific. Codex
        // doesn't set it — treat undefined as success.
        success = event.subtype === undefined || event.subtype === "success";
        cost = event.cost_usd;
      } else if (event.type === "error") {
        errorMessage = event.error;
      }
    }
  } catch (e) {
    errorMessage = (e as Error).message;
  }

  const feedbackPath = path.join(runDir, "feedback.json");
  let feedback: unknown;
  if (fs.existsSync(feedbackPath)) {
    try {
      feedback = JSON.parse(fs.readFileSync(feedbackPath, "utf-8"));
    } catch (e) {
      errorMessage =
        errorMessage ??
        `feedback.json was written but is not valid JSON: ${(e as Error).message}`;
    }
  }

  return {
    ok: success && !errorMessage && feedback !== undefined,
    task_id: opts.task_id,
    run_id: runId,
    cohort_dir: runDir,
    feedback_path: feedbackPath,
    feedback,
    member_count: members.length,
    members,
    duration_ms: Date.now() - startedAt,
    cost_usd: cost,
  };
}

/** Most-recent feedback for a task. Walks runs/ and returns the lexicographically-largest run's feedback.json. */
export function loadCohortFeedback(taskId: string): unknown {
  const runsDir = path.join(COHORTS_ROOT, taskId, "runs");
  if (!fs.existsSync(runsDir)) {
    // Backwards-compat: pre-run-keyed layout had cohorts/<task>/feedback.json directly.
    const legacy = path.join(COHORTS_ROOT, taskId, "feedback.json");
    if (fs.existsSync(legacy)) {
      try { return JSON.parse(fs.readFileSync(legacy, "utf-8")); } catch { return null; }
    }
    return null;
  }
  const runs = fs.readdirSync(runsDir).filter((n) => !n.startsWith(".")).sort();
  for (let i = runs.length - 1; i >= 0; i--) {
    const p = path.join(runsDir, runs[i], "feedback.json");
    if (!fs.existsSync(p)) continue;
    try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* skip */ }
  }
  return null;
}

/** List every persisted chart-review-cohort run for a task, newest first. */
export function listCohortRuns(taskId: string): CohortRunListing[] {
  const runsDir = path.join(COHORTS_ROOT, taskId, "runs");
  if (!fs.existsSync(runsDir)) return [];
  const out: CohortRunListing[] = [];
  for (const runId of fs.readdirSync(runsDir)) {
    const p = path.join(runsDir, runId, "feedback.json");
    if (!fs.existsSync(p)) continue;
    let generated_at = runId;
    let member_count: number | null = null;
    try {
      const fb = JSON.parse(fs.readFileSync(p, "utf8")) as {
        generated_at?: string;
        n_members?: number;
      };
      if (fb.generated_at) generated_at = fb.generated_at;
      if (typeof fb.n_members === "number") member_count = fb.n_members;
    } catch { /* keep defaults */ }
    out.push({ task_id: taskId, run_id: runId, generated_at, member_count });
  }
  return out.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
}

/** Read a specific chart-review-cohort run by run_id. */
export function readCohortRun(taskId: string, runId: string): unknown {
  const p = path.join(COHORTS_ROOT, taskId, "runs", runId, "feedback.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}
