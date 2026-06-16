import fs from "fs";
import path from "path";
import { guidelineDir, guidelinesRoot, loadSkillBundle, isSkillBundleAt } from "@chart-review/rubric";

/**
 * Top-level task kind discriminator. Used to dispatch phase routes, MCP
 * server selection, review-state schema, and judge/calibrate/etc. across
 * the two task families. Derived from meta.yaml's `task_type` field —
 * see `taskKindFromTaskType` for the normalization rules.
 */
export type TaskKind = "phenotype" | "ner" | "adherence";

/**
 * A field on a compiled task. Mirrors the contract in
 * ../../contracts/compiled_task.schema.json — only the keys we use here
 * are typed, the rest pass through.
 */
export interface CompiledField {
  id: string;
  prompt?: string;
  answer_schema?: unknown;
  cardinality?: string;
  time_window?: string;
  derivation?: string;
  is_applicable_when?: string;
  is_final_output?: boolean;
  extraction_guidance?: string;
  group?: string;
  guidance_prose?: Record<string, string>;
}

export interface CompiledTask {
  task_id: string;
  task_type?: string;
  /**
   * Derived discriminator. Set by `loadCompiledTask` / `listCompiledTasks`
   * via `taskKindFromTaskType(task_type)`. Defaults to `"phenotype"` when
   * `task_type` is absent or unrecognized — matches the implicit
   * assumption that pre-NER code carried.
   */
  task_kind?: TaskKind;
  /**
   * Declares that this task reads EHR structured data (OMOP). When true, the
   * run exposes the `list_structured_data` / `read_structured_data` MCP tools;
   * when absent/false the task is notes-only and those tools are NOT exposed
   * (no wasted tool descriptions, no agent calling them on a patient with no
   * structured data). Set per task in meta.yaml; spread through by
   * loadSkillBundle. See runOneAgent's tool-allowlist construction.
   */
  uses_structured_data?: boolean;
  review_unit?: string;
  manual_version?: string;
  source_document_sha: string;
  index_anchor?: string;
  time_windows?: { id: string; anchor: string; start_offset: string; end_offset: string }[];
  final_output?: string;
  overview_prose?: string;
  fields: CompiledField[];
}

/**
 * Normalize the raw meta.yaml `task_type` string to the typed `TaskKind`
 * discriminator. Existing meta.yaml files use `phenotype_validation`
 * (most) or `outcome_adjudication` (a few label-prediction skills) —
 * both are treated as the phenotype kind for now. NER tasks declare
 * `task_type: ner`.
 */
export function taskKindFromTaskType(taskType: string | undefined): TaskKind {
  if (taskType === "ner") return "ner";
  if (taskType === "adherence") return "adherence";
  return "phenotype";
}

function applyTaskKind<T extends { task_type?: string; task_kind?: TaskKind }>(t: T): T {
  t.task_kind = taskKindFromTaskType(t.task_type);
  return t;
}

/** Load a compiled task from .claude/skills/chart-review-<tid>/. All chart-review
 *  skills (drafts and locked) live at this canonical path; draft maturity is
 *  signaled by `status: draft` in meta.yaml. The legacy
 *  .claude/skills/drafts/chart-review-<tid>/ location is no longer read; run
 *  `npm run migrate-drafts` to consolidate any legacy artifacts. */
export function loadCompiledTask(taskId: string): CompiledTask | null {
  if (!isSkillBundleAt(guidelineDir(taskId))) return null;
  try {
    return applyTaskKind(loadSkillBundle(taskId) as unknown as CompiledTask);
  } catch {
    return null;
  }
}

/** List every chart-review-* skill bundle under .claude/skills/.
 *  Drafts and locked guidelines both live at the canonical path; draft
 *  maturity is signaled by `status: draft` in meta.yaml. The legacy
 *  .claude/skills/drafts/ subdirectory is no longer scanned. */
export function listCompiledTasks(): CompiledTask[] {
  const root = guidelinesRoot();
  if (!fs.existsSync(root)) return [];
  const out: CompiledTask[] = [];

  for (const name of fs.readdirSync(root).sort()) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    if (!name.startsWith("chart-review-")) continue;
    const sub = path.join(root, name);
    const stat = fs.statSync(sub, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;
    if (!isSkillBundleAt(sub)) continue;
    const taskId = name.slice("chart-review-".length);
    try {
      out.push(applyTaskKind(loadSkillBundle(taskId) as unknown as CompiledTask));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/**
 * Compact one-paragraph-per-field summary suitable for inlining in the
 * agent's system prompt. Keeps tokens reasonable while giving the model
 * the protocol vocabulary.
 */
export function fieldSummaryForPrompt(task: CompiledTask): string {
  const lines: string[] = [];
  lines.push(`Protocol: ${task.task_id} (manual ${task.manual_version ?? "?"})`);
  if (task.overview_prose) {
    lines.push(`Overview: ${task.overview_prose.split("\n").slice(0, 3).join(" ").slice(0, 600)}`);
  }
  lines.push(`\nFields (${task.fields.length}):`);
  for (const f of task.fields) {
    const kind =
      f.derivation
        ? "DERIVED"
        : f.is_applicable_when
          ? "GATED"
          : "LEAF";
    const schema = describeSchema(f.answer_schema);
    const prompt = (f.prompt ?? "").replace(/\s+/g, " ").trim();
    lines.push(
      `- ${f.id}  [${kind}${f.group ? `, ${f.group}` : ""}, ${schema}]\n    ${prompt}`,
    );
    if (f.is_applicable_when) {
      lines.push(`    only when: ${f.is_applicable_when}`);
    }
    if (f.derivation) {
      lines.push(`    derivation: ${f.derivation}`);
    }
  }
  if (task.final_output) {
    lines.push(`\nFinal output field: ${task.final_output}`);
  }
  return lines.join("\n");
}

function describeSchema(s: unknown): string {
  if (!s || typeof s !== "object") return "?";
  const obj = s as Record<string, unknown>;
  if (Array.isArray(obj.enum)) return `enum: ${(obj.enum as string[]).join(" | ")}`;
  if (obj.type === "boolean") return "boolean";
  if (Array.isArray(obj.type)) return (obj.type as string[]).join(" | ");
  if (typeof obj.type === "string") return obj.type;
  return "?";
}
