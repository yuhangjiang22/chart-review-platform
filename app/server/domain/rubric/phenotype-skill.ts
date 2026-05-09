// app/server/domain/rubric/phenotype-skill.ts
//
// Loader for the phenotype scope-skill format. Skill-format markdown is the
// only supported format for criterion loading at runtime; the authoring agent
// still writes YAML drafts, but `promoteDraft()` in authoring.ts converts each
// criterion to skill-format markdown at the authoring → live boundary, so by
// the time the runtime loads them they're always markdown.
//
// On-disk layout:
//
//   .claude/skills/chart-review-<taskId>/references/criteria/<field_id>.md
//
// Each markdown file is YAML-frontmatter + body sections; see
// loadPhenotypeCriteria below for the parser.

import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import type { KeywordSet, CodeSet, EdgeCase } from "./skill-bundle.js";
import { PLATFORM_ROOT } from "../../patients.js";

// ── Shared criterion interface ────────────────────────────────────────────────
//
// This interface captures the superset of fields that can appear in either the
// skill-format frontmatter OR the legacy YAML. Callers that previously read
// `CompiledTaskField` (which uses `id`) can use `field_id` as well — both
// are populated by the skill-format loader for backward compatibility.
//
// The index signature `[k: string]: unknown` matches the runtime shape:
// criteria carry whatever frontmatter the markdown file declares, so
// callers that pass criteria into hash/serialize helpers expecting a
// `Record<string, unknown>` shouldn't have to cast.

export interface CriterionFromSkill {
  /** Field identifier (new canonical key in skill format). */
  field_id: string;
  /** Legacy alias — populated by the loader for backward compatibility.
   *  Most server code reads `.id`; setting it here avoids breaking call sites. */
  id?: string;
  schema_hash?: string;
  prompt?: string;
  answer_schema?: unknown;
  cardinality?: string;
  time_window?: string;
  group?: string;
  derivation?: string;
  is_applicable_when?: string;
  is_final_output?: boolean;
  uses?: {
    code_sets?: string[];
    edge_cases?: string[];
    exemplars?: string[];
    keyword_sets?: string[];
  };
  /** Body prose from the markdown section (definition, examples, etc.).
   *  Populated only by the skill-format loader.
   *
   *  Preferred shape (lift B): the structured four-axis split surfaces
   *  positive cases, negative cases, boundary cases, and reviewer/author
   *  failure modes as separate keys. The legacy `examples` blob still
   *  parses for backward compatibility. */
  guidance_prose?: {
    definition?: string;
    satisfying_examples?: string;
    non_satisfying_examples?: string;
    boundary_examples?: string;
    failure_modes?: string;
    examples?: string;
    tier_rationale?: string;
  };
  extraction_guidance?: string;
  /** Frontmatter passes through whatever fields are declared. */
  [k: string]: unknown;
}

// ── Directory resolution ─────────────────────────────────────────────────────

/**
 * Resolve <taskId> to its skill directory under .claude/skills/.
 *
 * The convention is: skill directory = `chart-review-<taskId>`.
 * For example, taskId `lung-cancer-phenotype` maps to
 * `.claude/skills/chart-review-lung-cancer-phenotype/`.
 */
export function phenotypeSkillDir(taskId: string): string {
  // Re-read CHART_REVIEW_PLATFORM_ROOT each call so tests can override it via
  // the env without restarting the module. Falls back to the import-time
  // PLATFORM_ROOT for production paths.
  const root = process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT;
  // All chart-review skills (drafts and locked) live at this canonical path;
  // draft maturity is signaled by `status: draft` in meta.yaml. The legacy
  // .claude/skills/drafts/chart-review-<id>/ subdirectory is no longer read.
  return path.join(root, ".claude", "skills", `chart-review-${taskId}`);
}

// ── Skill-format loader ──────────────────────────────────────────────────────

/**
 * Load all criteria from the skill-format directory.
 * Reads `<phenotypeSkillDir>/references/criteria/*.md`, parses YAML
 * frontmatter from each file, and returns criterion objects.
 *
 * Returns an empty array (not an error) when the skill directory does not
 * exist — the caller uses this as the "not migrated yet" signal and falls
 * back to the legacy YAML path.
 */
export function loadPhenotypeCriteria(taskId: string): CriterionFromSkill[] {
  const criteriaDir = path.join(phenotypeSkillDir(taskId), "references", "criteria");
  if (!fs.existsSync(criteriaDir)) {
    return [];
  }
  const out: CriterionFromSkill[] = [];
  for (const filename of fs.readdirSync(criteriaDir).sort()) {
    if (!filename.endsWith(".md")) continue;
    const filepath = path.join(criteriaDir, filename);
    let txt: string;
    try {
      txt = fs.readFileSync(filepath, "utf8");
    } catch {
      continue; // skip unreadable files
    }
    // Parse YAML frontmatter: ---\n<yaml>\n---\n<body>
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/s.exec(txt);
    if (!m) continue;
    let front: CriterionFromSkill;
    try {
      front = parseYaml(m[1]) as CriterionFromSkill;
    } catch {
      continue; // skip unparseable frontmatter
    }
    if (!front?.field_id) continue;
    // Populate the legacy `.id` alias so callers that read `.id` keep working.
    front.id = front.field_id;
    // Optionally extract body prose for callers that want it.
    const body = (m[2] ?? "").trim();
    if (body) {
      const definitionMatch = /^##\s+Definition\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m.exec(body);
      const satisfyingMatch = /^##\s+Satisfying examples\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m.exec(body);
      const nonSatisfyingMatch = /^##\s+Non-satisfying examples\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m.exec(body);
      const boundaryMatch = /^##\s+Boundary examples\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m.exec(body);
      const failureMatch = /^##\s+Failure modes\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m.exec(body);
      const examplesMatch = /^##\s+Examples\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m.exec(body);
      const rationaleMatch = /^##\s+Rationale\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m.exec(body);
      if (
        definitionMatch || satisfyingMatch || nonSatisfyingMatch ||
        boundaryMatch || failureMatch || examplesMatch || rationaleMatch
      ) {
        front.guidance_prose = {
          definition: definitionMatch?.[1]?.trim(),
          satisfying_examples: satisfyingMatch?.[1]?.trim(),
          non_satisfying_examples: nonSatisfyingMatch?.[1]?.trim(),
          boundary_examples: boundaryMatch?.[1]?.trim(),
          failure_modes: failureMatch?.[1]?.trim(),
          examples: examplesMatch?.[1]?.trim(),
          tier_rationale: rationaleMatch?.[1]?.trim(),
        };
      }
      const extractionMatch = /^##\s+Extraction guidance\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m.exec(body);
      if (extractionMatch) {
        front.extraction_guidance = extractionMatch[1].trim();
      }
    }
    out.push(front);
  }
  return out;
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Load all criteria for a task from the skill-format markdown directory.
 * Returns an empty array (with a warning) if the directory does not exist —
 * usually a sign that the guideline hasn't been promoted yet, or that a
 * test is missing a fixture seed.
 */
export function loadCriteria(taskId: string): CriterionFromSkill[] {
  const out = loadPhenotypeCriteria(taskId);
  if (out.length === 0) {
    console.warn(
      `[phenotype-skill] ${taskId}: no criteria found at ` +
      `${path.relative(PLATFORM_ROOT, phenotypeSkillDir(taskId))}/references/criteria/`,
    );
  }
  return out;
}

// ── Operational loaders ──────────────────────────────────────────────────────

/**
 * Extract YAML frontmatter from a file and parse it.
 * Returns null if the file doesn't exist, has no frontmatter, or frontmatter is invalid.
 */
function readFrontmatter<T>(filepath: string): T | null {
  let txt: string;
  try {
    txt = fs.readFileSync(filepath, "utf8");
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/s.exec(txt);
  if (!m) return null;
  try {
    return parseYaml(m[1]) as T;
  } catch {
    return null;
  }
}

/**
 * Load all keyword sets from the skill-format directory.
 * Reads `<phenotypeSkillDir>/references/keyword_sets/*.md`, parses YAML
 * frontmatter from each file, and returns keyword set objects indexed by id.
 *
 * Returns an empty object when the keyword_sets directory does not exist.
 * Silently skips files with malformed frontmatter.
 */
export function loadKeywordSets(taskId: string): Record<string, KeywordSet> {
  const dir = path.join(phenotypeSkillDir(taskId), "references", "keyword_sets");
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, KeywordSet> = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const ks = readFrontmatter<KeywordSet>(path.join(dir, f));
    if (ks?.id) out[ks.id] = ks;
  }
  return out;
}

/**
 * Load all code sets from the skill-format directory.
 * Reads `<phenotypeSkillDir>/references/code_sets/*.md`, parses YAML
 * frontmatter from each file, and returns code set objects indexed by id.
 *
 * Returns an empty object when the code_sets directory does not exist.
 * Silently skips files with malformed frontmatter.
 */
export function loadCodeSets(taskId: string): Record<string, CodeSet> {
  const dir = path.join(phenotypeSkillDir(taskId), "references", "code_sets");
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, CodeSet> = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const cs = readFrontmatter<CodeSet>(path.join(dir, f));
    if (cs?.id) out[cs.id] = cs;
  }
  return out;
}

/**
 * Load all edge cases from the skill-format directory.
 * Reads `<phenotypeSkillDir>/references/edge_cases/*.md`, parses YAML
 * frontmatter from each file, and returns edge case objects as an array.
 *
 * Returns an empty array when the edge_cases directory does not exist.
 * Silently skips files with malformed frontmatter.
 */
export function loadEdgeCases(taskId: string): EdgeCase[] {
  const dir = path.join(phenotypeSkillDir(taskId), "references", "edge_cases");
  if (!fs.existsSync(dir)) return [];
  const out: EdgeCase[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const ec = readFrontmatter<EdgeCase>(path.join(dir, f));
    if (ec?.id) out.push(ec);
  }
  return out;
}

/**
 * Load all exemplars from the skill-format directory.
 * Reads `<phenotypeSkillDir>/references/exemplars/*.md` and returns the
 * full markdown content of each file indexed by id (filename without .md).
 *
 * Returns an empty object when the exemplars directory does not exist.
 * Silently skips files that cannot be read.
 */
export function loadExemplars(taskId: string): Record<string, string> {
  const dir = path.join(phenotypeSkillDir(taskId), "references", "exemplars");
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const id = f.replace(/\.md$/, "");
    try { out[id] = fs.readFileSync(path.join(dir, f), "utf8"); } catch { /* skip */ }
  }
  return out;
}

// ── Note-type filters loader ────────────────────────────────────────────────

export interface NoteTypeFilters {
  filters: Record<string, { high?: string[]; medium?: string[]; low?: string[] }>;
  description?: string;
  derived_from?: Record<string, unknown>;
}

/**
 * Load the package-level references/note_type_filters.md file.
 * Returns `{ filters: {} }` when the file is absent (codify hasn't run yet).
 */
export function loadNoteTypeFilters(taskId: string): NoteTypeFilters {
  const fp = path.join(phenotypeSkillDir(taskId), "references", "note_type_filters.md");
  if (!fs.existsSync(fp)) return { filters: {} };
  const fm = readFrontmatter<NoteTypeFilters>(fp);
  if (!fm) return { filters: {} };
  return { filters: fm.filters ?? {}, description: fm.description, derived_from: fm.derived_from };
}
