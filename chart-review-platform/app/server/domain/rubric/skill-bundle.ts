// app/server/skill-bundle.ts
//
// Loads chart-review GUIDELINE packages (data) from disk. Despite the file
// name, this module is not about Claude Code skills — those live in
// .claude/skills/<verb>/SKILL.md (the agent activates them at runtime).
// Guideline packages are domain data: criteria + accumulated keyword/code
// sets + edge cases + exemplars, all consumed by the chart-review skill.
//
// Layout:
//
//   <PLATFORM_ROOT>/guidelines/<guideline-id>/
//   ├── meta.yaml
//   ├── criteria/<field_id>.yaml
//   ├── keyword_sets/<id>.yaml          (optional)
//   ├── code_sets/<id>.yaml             (optional)
//   ├── edge_cases.yaml                 (optional)
//   └── exemplars/<id>.md               (optional)
//
// (We keep the historical name `loadSkillBundle` for now to limit churn;
// callers across server.ts, tasks.ts, rule-replay.ts, etc. all use it.
// The rename to `loadGuideline` can ship as a separate cleanup.)

import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_ROOT } from "../../patients.js";
import {
  loadCriteria,
  loadKeywordSets,
  loadCodeSets,
  loadEdgeCases,
  loadExemplars,
  loadNoteTypeFilters,
  type NoteTypeFilters,
} from "./phenotype-skill.js";

/** Root that holds every phenotype skill directory.
 *  In the new layout, every phenotype lives at <PLATFORM_ROOT>/.claude/skills/chart-review-<id>/.
 *  The CHART_REVIEW_GUIDELINES_ROOT env-var override is kept so that callers
 *  (authoring.ts, cohorts.test.ts, etc.) can still inject a custom root in
 *  tests or legacy configurations. T11/T12 will migrate those callers. */
export function guidelinesRoot(): string {
  if (process.env.CHART_REVIEW_GUIDELINES_ROOT) return process.env.CHART_REVIEW_GUIDELINES_ROOT;
  const root = process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT;
  return path.join(root, ".claude", "skills");
}

export interface CompiledTaskField {
  id: string;
  [k: string]: unknown;
}

/** A keyword set entry under a guideline's keyword_sets/. */
export interface KeywordSet {
  id: string;
  description?: string;
  terms?: string[];
  synonyms?: Record<string, string[]>;
  [k: string]: unknown;
}

/** A code set entry under a guideline's code_sets/. */
export interface CodeSet {
  id: string;
  description?: string;
  system?: string;
  codes?: Array<{ code: string; description?: string }>;
  includes_pattern?: string[];
  excludes?: Array<{ code: string; reason?: string }>;
  [k: string]: unknown;
}

/** One entry in a guideline's edge_cases.yaml. */
export interface EdgeCase {
  id: string;
  pattern?: string;
  applies_to?: string[];
  failure_mode?: string;
  correct_answer_hint?: string;
  example_ref?: string;
  [k: string]: unknown;
}

/** Accumulated operational knowledge in a guideline package. */
export interface OperationalLayer {
  keyword_sets: Record<string, KeywordSet>;
  code_sets: Record<string, CodeSet>;
  edge_cases: EdgeCase[];
  /** Map from exemplar id (filename minus .md) to its full markdown content. */
  exemplars: Record<string, string>;
  /** Per-criterion note-type priority, codified from the validated cohort.
   *  Empty `{ filters: {} }` when codify hasn't run yet (or no note evidence
   *  was captured). The chart-review skill uses this to prefer high-priority
   *  note types when narrowing search. */
  note_type_filters: NoteTypeFilters;
}

export interface CompiledTask {
  task_id: string;
  task_version?: string;
  review_unit?: string;
  stratify_by?: unknown[];
  source_document_sha?: string;
  fields: CompiledTaskField[];
  /** Accumulated operational knowledge, populated by loadSkillBundle. */
  operational?: OperationalLayer;
  [k: string]: unknown;
}

/** True if `dir` is a guideline package — has both meta.yaml and SKILL.md at the root.
 *  The SKILL.md requirement distinguishes phenotype skills from verb-skills (which
 *  have only SKILL.md) and from bare guidelines/ directories (which have only meta.yaml). */
function isGuideline(dir: string): boolean {
  return fs.existsSync(path.join(dir, "meta.yaml")) && fs.existsSync(path.join(dir, "SKILL.md"));
}

/** Resolve a taskId to its on-disk guideline dir (the phenotype skill directory).
 *  In the new layout: <guidelinesRoot()>/chart-review-<taskId>. */
export function guidelineDir(taskId: string): string {
  return path.join(guidelinesRoot(), `chart-review-${taskId}`);
}

/** Exposed for tasks.ts so loadCompiledTask / listCompiledTasks share the same guideline-detection. */
export function isSkillBundleAt(dir: string): boolean {
  return isGuideline(dir);
}

function loadOperationalLayer(taskId: string): OperationalLayer {
  return {
    keyword_sets: loadKeywordSets(taskId),
    code_sets: loadCodeSets(taskId),
    edge_cases: loadEdgeCases(taskId),
    exemplars: loadExemplars(taskId),
    note_type_filters: loadNoteTypeFilters(taskId),
  };
}

export function loadSkillBundle(taskId: string): CompiledTask {
  const dir = guidelineDir(taskId);
  if (!isGuideline(dir)) {
    throw new Error(`guideline not found: ${dir}`);
  }
  const meta = (parseYaml(fs.readFileSync(path.join(dir, "meta.yaml"), "utf8")) ?? {}) as Record<string, unknown>;
  // Criteria load through the unified rubric loader: skill-format markdown
  // when the phenotype skill exists, legacy YAML fallback for unmigrated
  // phenotypes (including freshly authored drafts that haven't been
  // migrated yet). Both paths populate `id` so downstream callers that
  // read `field.id` keep working.
  const fields = loadCriteria(taskId) as unknown as CompiledTaskField[];
  return {
    task_id: taskId,
    ...meta,
    fields,
    operational: loadOperationalLayer(taskId),
  } as CompiledTask;
}

