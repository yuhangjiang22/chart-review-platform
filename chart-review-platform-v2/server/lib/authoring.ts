/**
 * Role A — Authoring agent.
 *
 * Drives the `chart-review-author` verb skill (.claude/skills/chart-review-author/SKILL.md)
 * via composeAgentOptions. Same agent primitive as the chat copilot — different
 * skill, different cwd, different tools.
 *
 *   reviewer's objective + references  →  .claude/skills/chart-review-<task_id>/{meta.yaml, criteria/*.yaml, ...}
 *
 * Skills are written directly to the canonical live path (.claude/skills/chart-review-<id>/)
 * with status: draft in meta.yaml. "Promote" is a status flip from draft → locked,
 * not a directory rename. This matches the loader's path expectations (cluster 2).
 *
 * One-shot vs the chat agent's long-lived session — drafting is a single user
 * input and a single produced artifact (a directory).
 */

import fs from "fs";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runAgent } from "./agent-provider.js";
import { PLATFORM_ROOT } from "./patients.js";
import { loadSkillBundle, guidelineDir, guidelinesRoot } from "./domain/rubric/index.js";
import { yamlCriterionToSkillMarkdown } from "./domain/rubric/yaml-to-markdown.js";
import { getMaturity } from "./maturity.js";
import {
  createJob,
  appendJobEvent,
  updateJobStatus,
  type JobEventKind,
} from "./jobs.js";

/** Resolve the on-disk directory for a skill — canonical live path at .claude/skills/chart-review-<taskId>/.
 *  Draft state is conveyed by `status: draft` in meta.yaml, not by directory location. */
function draftSkillDir(taskId: string): string {
  return guidelineDir(taskId);
}

export interface DraftTaskOptions {
  task_id: string;
  objective: string;
  references?: string;
}

export interface DraftTaskResult {
  ok: boolean;
  task_id: string;
  draft_path?: string;
  draft_meta?: unknown;
  field_count?: number;
  error?: string;
  duration_ms: number;
  cost_usd?: number;
}

export type AuthoringEventKind =
  | "info"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error";

export interface AuthoringEvent {
  kind: AuthoringEventKind;
  payload: unknown;
}

export async function draftTask(
  opts: DraftTaskOptions,
  onEvent?: (ev: AuthoringEvent) => void,
): Promise<DraftTaskResult> {
  const emit = (ev: AuthoringEvent) => {
    try { onEvent?.(ev); } catch { /* never let callback errors break the run */ }
  };
  const startedAt = Date.now();

  if (!/^[a-z][a-z0-9-]+$/.test(opts.task_id)) {
    return {
      ok: false,
      task_id: opts.task_id,
      error: "task_id must be kebab-case (lowercase letters, digits, hyphens; starting with a letter)",
      duration_ms: 0,
    };
  }

  const draftPath = draftSkillDir(opts.task_id);
  // Pre-create the skill dir so the agent's cwd exists. The agent will
  // write files relative to cwd (i.e. inside this directory).
  fs.mkdirSync(draftPath, { recursive: true });
  // Write a placeholder SKILL.md so isGuideline() accepts this skill when
  // loadSkillBundle is called against it.
  const skillMdPath = path.join(draftPath, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    fs.writeFileSync(
      skillMdPath,
      `---\nname: chart-review-${opts.task_id}\ndescription: Draft phenotype skill (in development).\n---\n\nThis skill is a draft. Once promoted, the SKILL.md is regenerated with full agent activation content.\n`,
    );
  }
  // Write a stub meta.yaml with status: draft so the loader recognises this
  // as a live-but-draft skill even before the agent finishes writing its own.
  const stubMetaPath = path.join(draftPath, "meta.yaml");
  if (!fs.existsSync(stubMetaPath)) {
    fs.writeFileSync(
      stubMetaPath,
      `task_id: ${opts.task_id}\nstatus: draft\n`,
    );
  }
  emit({ kind: "info", payload: { stage: "started", draft_path: draftPath } });

  const userPrompt = [
    `Use the \`chart-review-author\` skill to draft a chart-review guideline package.`,
    "",
    `task_id: ${opts.task_id}`,
    `Your working directory IS the output directory; write files with relative paths`,
    `(meta.yaml, criteria/<field>.yaml, etc.) — do NOT use absolute paths or .. segments.`,
    "",
    "## Objective",
    opts.objective,
    "",
    opts.references
      ? "## Reference material (paste from PI)\n" + opts.references
      : "",
    "",
    "Write the guideline files (meta.yaml, criteria/*.yaml, optional keyword_sets/, " +
      "code_sets/, edge_cases.yaml) into your current working directory. After writing, " +
      "summarize the draft in 3-5 sentences for the reviewer.",
  ]
    .filter(Boolean)
    .join("\n");

  let cost: number | undefined;
  let success = false;
  let errorMessage: string | undefined;

  try {
    for await (const event of runAgent({
      prompt: userPrompt,
      // Scope the Write tool to the draft directory by making it the cwd.
      // The SDK still walks up to find .claude/skills/ at the platform root.
      cwd: draftPath,
      taskId: opts.task_id,
      // No guidelinePath — this skill is creating the guideline, not consuming one.
      extraTools: ["Write"],
      maxTurns: 30,
      permissionMode: "acceptEdits",
      extraSystemPrompt:
        "Activate the `chart-review-author` skill via the Skill tool. Write all " +
        "files into your current working directory using relative paths. Do not " +
        "write outside the cwd.",
    })) {
      // Translate normalized AgentEvents into AuthoringEvents for the
      // optional onEvent callback.
      if (event.type === "text") {
        emit({ kind: "assistant_text", payload: event.text });
      } else if (event.type === "tool_use") {
        emit({
          kind: "tool_use",
          payload: { name: event.tool_name, input: event.tool_input },
        });
      } else if (event.type === "tool_result") {
        emit({
          kind: "tool_result",
          payload: { tool_use_id: event.tool_use_id, is_error: false },
        });
      } else if (event.type === "result") {
        success = event.subtype === "success";
        cost = event.cost_usd;
        emit({
          kind: "result",
          payload: { subtype: event.subtype, total_cost_usd: event.cost_usd },
        });
      } else if (event.type === "error") {
        errorMessage = event.error;
        emit({ kind: "error", payload: event.error });
      }
    }
  } catch (e) {
    errorMessage = (e as Error).message;
    emit({ kind: "error", payload: errorMessage });
  }

  if (!fs.existsSync(path.join(draftPath, "meta.yaml"))) {
    return {
      ok: false,
      task_id: opts.task_id,
      error:
        errorMessage ??
        `agent finished but did not write ${path.relative(PLATFORM_ROOT, draftPath)}/meta.yaml`,
      duration_ms: Date.now() - startedAt,
      cost_usd: cost,
    };
  }

  // Load the just-written draft to surface a summary back to the caller.
  let draft_meta: unknown;
  let field_count: number | undefined;
  try {
    const meta = (await import("yaml")).parse(
      fs.readFileSync(path.join(draftPath, "meta.yaml"), "utf8"),
    );
    draft_meta = meta;
    const criteriaDir = path.join(draftPath, "criteria");
    field_count = fs.existsSync(criteriaDir)
      ? fs.readdirSync(criteriaDir).filter((f) => f.endsWith(".yaml")).length
      : 0;
  } catch {
    /* read-back is best-effort */
  }

  return {
    ok: success && !errorMessage,
    task_id: opts.task_id,
    draft_path: draftPath,
    draft_meta,
    field_count,
    error: errorMessage,
    duration_ms: Date.now() - startedAt,
    cost_usd: cost,
  };
}

/**
 * Streaming variant: returns a job_id synchronously, runs draftTask in
 * the background, and pipes every agent event into the job's transcript.
 * The caller is expected to (optionally) subscribe to WS
 * `agent_job_update` events filtered by job_id, plus poll
 * `GET /api/jobs/<id>` for the final status.
 */
export function startDraftJob(
  opts: DraftTaskOptions & { started_by: string },
  onJobEvent?: (jobId: string) => void,
): { job_id: string } {
  const { manifest } = createJob({
    kind: "authoring",
    task_id: opts.task_id,
    started_by: opts.started_by,
    payload: { task_id: opts.task_id, has_objective: !!opts.objective, has_references: !!opts.references },
  });
  const jobId = manifest.job_id;

  // Fire-and-forget. Errors land in the job status.
  (async () => {
    try {
      const result = await draftTask(opts, (ev) => {
        appendJobEvent(jobId, { kind: ev.kind as JobEventKind, payload: ev.payload });
        onJobEvent?.(jobId);
      });
      updateJobStatus(jobId, {
        state: result.ok ? "complete" : "error",
        completed_at: new Date().toISOString(),
        result,
        error: result.error,
        cost_usd: result.cost_usd,
        duration_ms: result.duration_ms,
      });
      onJobEvent?.(jobId);
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      appendJobEvent(jobId, { kind: "error", payload: message });
      updateJobStatus(jobId, {
        state: "error",
        completed_at: new Date().toISOString(),
        error: message,
      });
      onJobEvent?.(jobId);
    }
  })();

  return { job_id: jobId };
}

export interface DraftListing {
  task_id: string;
  path: string;
  field_count: number;
  has_meta: boolean;
  modified_at: string;
}

export function listDrafts(): DraftListing[] {
  const skillsRoot = guidelinesRoot();
  if (!fs.existsSync(skillsRoot)) return [];
  return fs
    .readdirSync(skillsRoot)
    .filter((name) => {
      if (name.startsWith(".") || !name.startsWith("chart-review-")) return false;
      const full = path.join(skillsRoot, name);
      if (!fs.statSync(full).isDirectory()) return false;
      // Only list skills with status: draft in meta.yaml.
      const metaPath = path.join(full, "meta.yaml");
      if (!fs.existsSync(metaPath)) return false;
      try {
        const meta = parseYaml(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        return meta?.status === "draft";
      } catch {
        return false;
      }
    })
    .map((name): DraftListing => {
      const full = path.join(skillsRoot, name);
      const stat = fs.statSync(full);
      // Drafts are skill-shaped: criteria live under references/criteria/*.md
      // but the authoring agent still writes YAML to criteria/*.yaml during the
      // draft phase. Count YAML files for the field_count summary.
      const criteriaDir = path.join(full, "criteria");
      const field_count = fs.existsSync(criteriaDir)
        ? fs.readdirSync(criteriaDir).filter((f) => f.endsWith(".yaml")).length
        : 0;
      // Strip the "chart-review-" prefix to recover the task_id.
      const task_id = name.slice("chart-review-".length);
      return {
        task_id,
        path: full,
        field_count,
        has_meta: true, // already verified above
        modified_at: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

/**
 * Load a draft as a CompiledTask shape (same as a locked guideline). Reads from
 * the canonical live path .claude/skills/chart-review-<task_id>/ (status: draft in meta.yaml).
 * Returns null if the skill is missing or malformed.
 */
export function readDraft(taskId: string): unknown | null {
  if (!/^[a-z][a-z0-9-]+$/.test(taskId)) return null;
  const draftPath = draftSkillDir(taskId);
  if (!fs.existsSync(path.join(draftPath, "meta.yaml"))) return null;
  try {
    return loadSkillBundle(taskId);
  } catch {
    return null;
  }
}


/** Copy a directory tree, skipping auxiliary subdirs (`_*`) and `versions/`. */
function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name.startsWith("_") || name === "versions") continue;
    const sp = path.join(src, name);
    const dp = path.join(dst, name);
    const stat = fs.statSync(sp);
    if (stat.isDirectory()) {
      copyDirRecursive(sp, dp);
    } else {
      fs.copyFileSync(sp, dp);
    }
  }
}

export interface PromoteDraftOptions {
  task_id: string;
  /** If true, overwrite an existing live guideline at this task_id. Defaults to false. */
  force?: boolean;
}

export interface PromoteDraftResult {
  ok: boolean;
  task_id: string;
  guideline_path?: string;
  field_count?: number;
  error?: string;
}

/**
 * Promote a draft skill at `.claude/skills/chart-review-<task_id>/` from `status: draft` to
 * `status: locked`. This is a status-flip operation on meta.yaml — no directory rename is
 * needed because the skill already lives at the canonical live path.
 *
 * Validates that the draft has meta.yaml (with status: draft) and at least one criterion.
 * Converts YAML criteria → skill-format markdown at the authoring → locked boundary.
 */
export function promoteDraft(opts: PromoteDraftOptions): PromoteDraftResult {
  if (!/^[a-z][a-z0-9-]+$/.test(opts.task_id)) {
    return {
      ok: false,
      task_id: opts.task_id,
      error: "task_id must be kebab-case (lowercase letters, digits, hyphens; starting with a letter)",
    };
  }

  const skillPath = draftSkillDir(opts.task_id);
  const metaPath = path.join(skillPath, "meta.yaml");
  if (!fs.existsSync(metaPath)) {
    return {
      ok: false,
      task_id: opts.task_id,
      error: `no skill at ${path.relative(PLATFORM_ROOT, skillPath)}/meta.yaml`,
    };
  }

  let meta: Record<string, unknown>;
  try {
    meta = parseYaml(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      task_id: opts.task_id,
      error: `failed to parse meta.yaml: ${(e as Error).message}`,
    };
  }

  if (meta?.status !== "draft") {
    // Not a draft — refuse unless force is set (and it isn't already locked).
    if (!opts.force) {
      return {
        ok: false,
        task_id: opts.task_id,
        error: `skill ${opts.task_id} has status '${meta?.status ?? "unknown"}', not 'draft'; pass force:true to promote anyway`,
      };
    }
  }

  // #38 maturity gate: never overwrite a locked guideline, even with
  // force:true. The methodologist must explicitly unlock first.
  if (getMaturity(opts.task_id).state === "locked") {
    return {
      ok: false,
      task_id: opts.task_id,
      error: `skill ${opts.task_id} is LOCKED — refusing promote. Unlock via POST /api/guidelines/${opts.task_id}/maturity first.`,
    };
  }

  const criteriaDir = path.join(skillPath, "criteria");
  const criteriaFiles = fs.existsSync(criteriaDir)
    ? fs.readdirSync(criteriaDir).filter((f) => f.endsWith(".yaml"))
    : [];
  if (criteriaFiles.length === 0) {
    return {
      ok: false,
      task_id: opts.task_id,
      error: `skill has no criteria/*.yaml under ${path.relative(PLATFORM_ROOT, criteriaDir)}`,
    };
  }

  // Convert YAML criteria → skill-format markdown at the draft → locked boundary.
  // The authoring agent writes YAML drafts; production reads the skill-format
  // markdown via loadCriteria. The YAML criteria are kept in
  // .claude/skills/chart-review-<task>/criteria/ as the version-archive snapshot
  // format — version-archive.ts:archiveVersion copies them into versions/<sha>/criteria/.
  const skillCriteriaDir = path.join(skillPath, "references", "criteria");
  // Wipe any pre-existing skill-format criteria so a re-promote doesn't leave orphans.
  if (fs.existsSync(skillCriteriaDir)) {
    fs.rmSync(skillCriteriaDir, { recursive: true, force: true });
  }
  fs.mkdirSync(skillCriteriaDir, { recursive: true });
  for (const filename of criteriaFiles) {
    const yamlText = fs.readFileSync(path.join(criteriaDir, filename), "utf8");
    const crit = parseYaml(yamlText) as Record<string, unknown>;
    const fieldId = (crit.field_id ?? crit.id) as string | undefined;
    if (typeof fieldId !== "string" || !fieldId) {
      return {
        ok: false,
        task_id: opts.task_id,
        error: `criterion ${filename} has no \`id\` or \`field_id\` — cannot convert to skill-format`,
      };
    }
    const md = yamlCriterionToSkillMarkdown(crit);
    fs.writeFileSync(path.join(skillCriteriaDir, `${fieldId}.md`), md);
  }

  // Flip status: draft → locked in meta.yaml.
  meta.status = "locked";
  fs.writeFileSync(metaPath, stringifyYaml(meta));

  return {
    ok: true,
    task_id: opts.task_id,
    guideline_path: skillPath,
    field_count: criteriaFiles.length,
  };
}

export interface ForkLockedToDraftOptions {
  /** Source — must exist as a live guideline at `guidelines/<src_task_id>/`. */
  src_task_id: string;
  /** Destination draft id. If omitted, autoincrements `<src>-rev1`, `-rev2`, …. */
  new_task_id?: string;
  /** If true and the destination draft already exists, wipe + overwrite it. */
  force?: boolean;
}

export interface ForkLockedToDraftResult {
  ok: boolean;
  src_task_id: string;
  new_task_id?: string;
  draft_path?: string;
  field_count?: number;
  error?: string;
}

/**
 * Copy a live guideline at `.claude/skills/chart-review-<src_task_id>/` into a new draft at
 * `.claude/skills/chart-review-<new_task_id>/` with status: draft in meta.yaml. Used by the
 * Guideline tab's "Edit" affordance — locked guidelines aren't edited in place; instead the
 * user forks them and edits proceed against the new draft at the canonical live path.
 *
 * Skips `maturity.json` (the new draft starts at draft state) and the
 * builder/ session subdir (a fresh session lazily appears on first WS).
 * `versions/` and `_*` are already excluded by copyDirRecursive.
 */
export function forkLockedToDraft(opts: ForkLockedToDraftOptions): ForkLockedToDraftResult {
  if (!/^[a-z][a-z0-9-]+$/.test(opts.src_task_id)) {
    return {
      ok: false,
      src_task_id: opts.src_task_id,
      error: "src_task_id must be kebab-case (lowercase letters, digits, hyphens; starting with a letter)",
    };
  }

  const srcPath = guidelineDir(opts.src_task_id);
  if (!fs.existsSync(path.join(srcPath, "meta.yaml"))) {
    return {
      ok: false,
      src_task_id: opts.src_task_id,
      error: `no live guideline at ${path.relative(PLATFORM_ROOT, srcPath)}/meta.yaml`,
    };
  }

  // Resolve the destination draft id — explicit override wins; otherwise
  // pick the lowest unused `<src>-revN` slot.
  let newTaskId = opts.new_task_id;
  if (!newTaskId) {
    let n = 1;
    while (fs.existsSync(draftSkillDir(`${opts.src_task_id}-rev${n}`))) n++;
    newTaskId = `${opts.src_task_id}-rev${n}`;
  } else if (!/^[a-z][a-z0-9-]+$/.test(newTaskId)) {
    return {
      ok: false,
      src_task_id: opts.src_task_id,
      error: "new_task_id must be kebab-case (lowercase letters, digits, hyphens; starting with a letter)",
    };
  }

  const draftPath = draftSkillDir(newTaskId);
  if (fs.existsSync(draftPath)) {
    if (!opts.force) {
      return {
        ok: false,
        src_task_id: opts.src_task_id,
        new_task_id: newTaskId,
        error: `draft already exists at ${path.relative(PLATFORM_ROOT, draftPath)}; pass force:true to overwrite or pick a different new_task_id`,
      };
    }
    fs.rmSync(draftPath, { recursive: true, force: true });
  }

  copyDirRecursive(srcPath, draftPath);

  // Write a placeholder SKILL.md so isGuideline() accepts this forked draft.
  const skillMdPath = path.join(draftPath, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    fs.writeFileSync(
      skillMdPath,
      `---\nname: chart-review-${newTaskId}\ndescription: Draft phenotype skill (in development).\n---\n\nThis skill is a draft. Once it's promoted, the SKILL.md is regenerated with full agent activation content.\n`,
    );
  }

  // Strip artifacts that don't belong to a fresh draft.
  const maturityFile = path.join(draftPath, "maturity.json");
  if (fs.existsSync(maturityFile)) fs.rmSync(maturityFile);
  const builderDir = path.join(draftPath, "builder");
  if (fs.existsSync(builderDir)) fs.rmSync(builderDir, { recursive: true, force: true });

  // Reset status to draft in meta.yaml — the fork starts life as a new draft,
  // regardless of the source skill's status (e.g. locked). This is what makes
  // the forked copy visible to listDrafts() and invisible to the production loader.
  const forkMetaPath = path.join(draftPath, "meta.yaml");
  if (fs.existsSync(forkMetaPath)) {
    try {
      const forkMeta = parseYaml(fs.readFileSync(forkMetaPath, "utf8")) as Record<string, unknown>;
      forkMeta.status = "draft";
      forkMeta.task_id = newTaskId;
      fs.writeFileSync(forkMetaPath, stringifyYaml(forkMeta));
    } catch {
      // Best-effort: if parse fails, write a minimal stub.
      fs.writeFileSync(forkMetaPath, `task_id: ${newTaskId}\nstatus: draft\n`);
    }
  } else {
    fs.writeFileSync(forkMetaPath, `task_id: ${newTaskId}\nstatus: draft\n`);
  }

  const criteriaDir = path.join(draftPath, "criteria");
  const fieldCount = fs.existsSync(criteriaDir)
    ? fs.readdirSync(criteriaDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).length
    : 0;

  return {
    ok: true,
    src_task_id: opts.src_task_id,
    new_task_id: newTaskId,
    draft_path: draftPath,
    field_count: fieldCount,
  };
}
