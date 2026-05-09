/**
 * Methods-section drafter driver.
 *
 * Drives the `chart-review-methods` verb skill
 * (.claude/skills/chart-review-methods/SKILL.md) via composeAgentOptions.
 *
 *   compiled task + computeQAStats  →  methods/<task_id>/<run_id>/{draft.md, provenance.json}
 *
 * One-shot, no tools (pure text generation). The assistant's text is
 * extracted from the SDKResultMessage.result field. Each invocation is
 * persisted as a run-keyed bundle so the PI can compare drafts over time
 * and trace any draft back to the guideline SHA + QA snapshot it was
 * generated from.
 */

import fs from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { modelFor } from "./model-config.js";
import { computeQAStats } from "./qa-panel.js";
import { loadCompiledTask } from "./tasks.js";
import { PLATFORM_ROOT } from "./patients.js";
import { composeAgentOptions } from "./compose-agent.js";
import { computeTaskSha } from "./lock.js";
import { guidelineDir } from "./domain/rubric/index.js";

function methodsRoot(): string {
  return process.env.CHART_REVIEW_METHODS_ROOT ?? path.join(PLATFORM_ROOT, "methods");
}

/** #50 — paper sections the drafter can produce. The chart-review-methods
 *  skill knows how to handle each via a section-specific prompt. */
export type PaperSection =
  | "methods"
  | "results"
  | "limitations"
  | "supplement";

export interface MethodsDraftProvenance {
  task_id: string;
  run_id: string;
  generated_at: string;
  guideline_sha: string | null;
  model: string;
  duration_ms: number;
  cost_usd?: number;
  qa_snapshot: unknown;
  /** #50 — which paper section this run produced. Defaults to "methods" for
   *  backwards compatibility with the original one-shot endpoint. */
  section?: PaperSection;
  /** #49 — when set, this run is a revision of a previous draft. Lets the
   *  UI render an iterative chain (v1 → v2 → v3) so the reviewer can see
   *  what changed across iterations. */
  prior_run_id?: string;
  /** #49 — reviewer's feedback that drove this revision (when present). */
  feedback?: string;
}

export interface MethodsDraftRun {
  ok: boolean;
  markdown: string;
  provenance: MethodsDraftProvenance;
  draft_path: string;
}

export interface MethodsDraftListing {
  task_id: string;
  run_id: string;
  generated_at: string;
  guideline_sha: string | null;
}

/** #49 + #50 — drafter input. All optional except taskId. */
export interface DraftInput {
  taskId: string;
  reviewsRoot: string;
  /** #50 — defaults to "methods" so the legacy POST keeps working. */
  section?: PaperSection;
  /** #49 — prior draft markdown the model should revise. */
  prior_draft?: string;
  /** #49 — reviewer's feedback driving the revision. */
  feedback?: string;
  /** #49 — link this run back to its predecessor for the iteration chain. */
  prior_run_id?: string;
}

const SECTION_PROMPTS: Record<PaperSection, { word_target: string; description: string }> = {
  methods: {
    word_target: "~300-500 words",
    description: "Methods section describing the chart-review protocol, guideline definition, agent draft + reviewer validation pipeline, and inter-rater reliability stats.",
  },
  results: {
    word_target: "~250-450 words",
    description: "Results section reporting cohort size, per-criterion field counts, agreement statistics (κ, % agreement, CIs), and any notable patterns from the QA snapshot.",
  },
  limitations: {
    word_target: "~150-300 words",
    description: "Limitations section honestly enumerating sample-size limits, calibration constraints, single-site data, agent reliability bounds, and threats to external validity.",
  },
  supplement: {
    word_target: "~200-500 words",
    description: "Supplementary methods with deeper protocol details, reviewer training notes, edge-case handling, and the rule-promotion workflow.",
  },
};

export async function draftMethodsSection(
  taskIdOrInput: string | DraftInput,
  reviewsRoot?: string,
): Promise<MethodsDraftRun> {
  // Backwards compat: legacy callers pass (taskId, reviewsRoot) positionally.
  const input: DraftInput = typeof taskIdOrInput === "string"
    ? { taskId: taskIdOrInput, reviewsRoot: reviewsRoot ?? "" }
    : taskIdOrInput;
  const startedAt = Date.now();
  const taskId = input.taskId;
  const section: PaperSection = input.section ?? "methods";
  const sectionInfo = SECTION_PROMPTS[section];
  const task = loadCompiledTask(taskId);
  const qa = await computeQAStats(taskId, input.reviewsRoot);

  const guidelinePath = task ? guidelineDir(taskId) : undefined;
  const guidelineSha = guidelinePath && fs.existsSync(guidelinePath)
    ? computeTaskSha(guidelinePath)
    : null;

  const promptParts: string[] = [
    `Use the \`chart-review-methods\` skill to write a **${section}** section for this study.`,
    "",
    `Section target: ${sectionInfo.description} (${sectionInfo.word_target})`,
    "",
    `Guideline: ${taskId}`,
    guidelinePath
      ? `Guideline path: ${path.relative(PLATFORM_ROOT, guidelinePath)}`
      : "(guideline not found on disk; using QA stats only)",
    guidelineSha ? `Guideline SHA: ${guidelineSha}` : "",
    "",
    "## QA stats",
    "```json",
    JSON.stringify(qa, null, 2),
    "```",
    "",
  ];
  if (input.prior_draft) {
    promptParts.push(
      "## Prior draft (revise this — do not start from scratch)",
      "```markdown",
      input.prior_draft.trim(),
      "```",
      "",
    );
  }
  if (input.feedback?.trim()) {
    promptParts.push(
      "## Reviewer feedback (apply this in the revision)",
      input.feedback.trim(),
      "",
    );
  }
  promptParts.push(`Return ONLY the markdown ${section} section text — no preamble, no commentary.`);
  const userPrompt = promptParts.filter(Boolean).join("\n");

  let resultText = "";
  let cost: number | undefined;

  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: composeAgentOptions({
        cwd: PLATFORM_ROOT,
        taskId,
        guidelinePath,
        maxTurns: 1,
        extraSystemPrompt:
          `Activate the \`chart-review-methods\` skill via the Skill tool. ` +
          `Follow its procedure to produce a ${sectionInfo.word_target} ${section} ` +
          `section in markdown. ${input.prior_draft ? "This is a revision; integrate the reviewer feedback above." : ""} ` +
          `Output the markdown text only — no preamble, no commentary.`,
      }) as any,
    })) {
      if ((msg as any)?.type === "result") {
        const result = (msg as any).result as string | undefined;
        if (result) resultText = result;
        const c = (msg as any).total_cost_usd as number | undefined;
        if (typeof c === "number") cost = c;
      }
    }
  } catch (e) {
    throw new Error(`methods-drafter query failed: ${(e as Error).message}`);
  }

  const markdown = resultText.trim();
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replace(/[:.]/g, "-");
  const runDir = path.join(methodsRoot(), taskId, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const provenance: MethodsDraftProvenance = {
    task_id: taskId,
    run_id: runId,
    generated_at: generatedAt,
    guideline_sha: guidelineSha,
    model: modelFor("default") ?? "(unset)",
    duration_ms: Date.now() - startedAt,
    cost_usd: cost,
    qa_snapshot: qa,
    section,
    prior_run_id: input.prior_run_id,
    feedback: input.feedback,
  };

  fs.writeFileSync(path.join(runDir, "draft.md"), markdown);
  fs.writeFileSync(path.join(runDir, "provenance.json"), JSON.stringify(provenance, null, 2));

  return {
    ok: markdown.length > 0,
    markdown,
    provenance,
    draft_path: path.join(runDir, "draft.md"),
  };
}

/** List every persisted methods draft for a task, newest first. */
export function listMethodsDrafts(taskId: string): MethodsDraftListing[] {
  const dir = path.join(methodsRoot(), taskId);
  if (!fs.existsSync(dir)) return [];
  const out: MethodsDraftListing[] = [];
  for (const runId of fs.readdirSync(dir)) {
    const provPath = path.join(dir, runId, "provenance.json");
    if (!fs.existsSync(provPath)) continue;
    try {
      const prov = JSON.parse(fs.readFileSync(provPath, "utf8")) as MethodsDraftProvenance;
      out.push({
        task_id: taskId,
        run_id: prov.run_id,
        generated_at: prov.generated_at,
        guideline_sha: prov.guideline_sha,
      });
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
}

/** Load a persisted methods draft by run_id. */
export function readMethodsDraft(
  taskId: string,
  runId: string,
): { markdown: string; provenance: MethodsDraftProvenance } | null {
  const runDir = path.join(methodsRoot(), taskId, runId);
  const draftPath = path.join(runDir, "draft.md");
  const provPath = path.join(runDir, "provenance.json");
  if (!fs.existsSync(draftPath) || !fs.existsSync(provPath)) return null;
  try {
    return {
      markdown: fs.readFileSync(draftPath, "utf8"),
      provenance: JSON.parse(fs.readFileSync(provPath, "utf8")) as MethodsDraftProvenance,
    };
  } catch {
    return null;
  }
}
