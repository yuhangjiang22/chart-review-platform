// Declarative per-task tool surface. ONE source of truth for which tools a run
// exposes, replacing the scattered phenotypeToolset()/adherenceTools gates in
// infra-batch-run. Hybrid tool location (decided in the design): write +
// note-faithfulness tools are MCP (baseTools/mcpTools); read/compute tools a task
// supplies are sidecar Python plugins (pythonPlugins). See
// docs/superpowers/specs/2026-06-16-per-task-tool-registry-design.md.
import type { CompiledTask } from "@chart-review/tasks";

/** Phenotype's MCP surface: notes + criteria + write/evidence/status. */
export const PHENOTYPE_BASE_TOOLS = [
  "list_notes", "read_note", "read_notes", "search_notes", "get_note_section",
  "list_criteria", "read_criterion", "read_criteria",
  "find_quote_offsets", "set_field_assessment", "select_evidence",
  "set_summary", "set_review_status", "get_review_state", "recommend_keywords",
];
/** Adherence's MCP surface: its question tools + notes + status (no phenotype write). */
export const ADHERENCE_BASE_TOOLS = [
  "list_questions", "read_question", "set_question_answer", "get_adherence_state",
  "list_notes", "read_note", "read_notes", "search_notes", "get_note_section", "set_review_status",
];
/** EHR/OMOP read tools, added when a task opts into structured data. */
export const STRUCTURED_DATA_TOOLS = ["list_structured_data", "read_structured_data"];

export interface PerItemSpec {
  /** rubric leaf this pass scores (must match a criteria field_id). */
  field_id: string;
  /** RUCAM item number, 1-7 — display + ordering. */
  item_number: number;
  /** backend path to the item's scoring methodology (read first each pass). */
  skill_file: string;
  /** note-search terms the per-item prompt forces via search_notes. */
  keywords: string[];
}

/** A group of rubric leaves scored together in ONE short, fresh conversation
 *  (grouped/compacted invocation). Leaves that share the same evidence go in one
 *  group; shared case foundations are computed once and injected into each group. */
export interface PerGroupSpec {
  /** stable group key (display + ordering). */
  group_id: string;
  /** human-facing title (e.g. "Onset & Course"). */
  title: string;
  /** the rubric leaf field_ids this group commits (all must match criteria). */
  field_ids: string[];
  /** backend paths to the scoring methods this group reads first each pass. */
  skill_files: string[];
  /** note-search terms the group prompt forces via search_notes. */
  keywords: string[];
}

export interface ToolProfile {
  /** Shared MCP tools for this task's kind (notes/criteria/write). */
  baseTools: string[];
  /** Adds STRUCTURED_DATA_TOOLS to the allowlist. Folds in `uses_structured_data`. */
  structuredData: boolean;
  /** Extra task-specific tools registered in the stdio server (TS). */
  mcpTools: string[];
  /** Read/compute tools the sidecar loads as Python plugins (import paths). */
  pythonPlugins: string[];
  /** Skill dirs/files to load (empty = the task's own bundle, loaded elsewhere). */
  skills: string[];
  /** Backing data adapter id. */
  dataSource: string;
  /** Per-item scoring specs (RUCAM only). Undefined for tasks without per-item invocation. */
  perItem?: PerItemSpec[];
  /** Grouped/compacted scoring specs (RUCAM). When set, the sidecar computes shared
   *  foundations once, then runs one short fresh conversation per group of leaves. */
  perGroup?: PerGroupSpec[];
}

/**
 * RUCAM grouped/compacted invocation. The 24 agent-committed leaves are split
 * into groups by SHARED EVIDENCE, so each group runs as one short, fresh
 * conversation (system prompt + a once-computed case-facts block + compact
 * prior-group summaries + only this group's leaves) — context never accumulates
 * across all 24 leaves, so cost stops growing super-linearly. This targets
 * LEAVES (not the derived item_N fields) and stays serial, avoiding the two
 * failure modes that retired the old per-item loop (guard-rejected derived
 * fields + parallel-tool-call rejection storms). Items 1-7, total, and category
 * are still DERIVED by the platform from these leaves — no scoring change.
 */
export const RUCAM_GROUPS: PerGroupSpec[] = [
  {
    group_id: "onset_course",
    title: "Onset & Course (items 1-2)",
    field_ids: ["onset_path", "onset_latency_days", "injury_track", "dechallenge_outcome"],
    skill_files: [
      ".claude/skills/chart-review-rucam/references/scoring/item-1-onset.md",
      ".claude/skills/chart-review-rucam/references/scoring/item-2-cessation.md",
    ],
    keywords: ["started", "initiated", "stopped", "discontinued", "held", "ALT", "AST", "ALP", "bilirubin"],
  },
  {
    group_id: "risk",
    title: "Risk factors (item 3)",
    field_ids: ["rf_age_ge_55", "rf_alcohol", "rf_pregnancy"],
    skill_files: [".claude/skills/chart-review-rucam/references/scoring/item-3-risk-factors.md"],
    keywords: ["age", "alcohol", "ethanol", "pregnant", "pregnancy", "gestation"],
  },
  {
    group_id: "concomitant",
    title: "Concomitant drugs (item 4)",
    field_ids: ["concomitant_worst_timing", "concomitant_worst_hepatotoxic", "concomitant_attribution"],
    skill_files: [".claude/skills/chart-review-rucam/references/scoring/item-4-concomitant.md"],
    keywords: ["medication", "home meds", "concomitant", "started", "Z-pack", "antibiotic", "supplement", "herbal"],
  },
  {
    group_id: "exclusion",
    title: "Exclusion of other causes (item 5)",
    field_ids: [
      "g1_hav_ruled_out", "g1_hbv_ruled_out", "g1_hcv_ruled_out",
      "g1_biliary_obstruction_ruled_out", "g1_alcoholism_ruled_out", "g1_ischemia_ruled_out",
      "g2_autoimmune_ruled_out", "g2_sepsis_ruled_out", "g2_pbc_psc_ruled_out",
      "g2_cmv_ebv_hsv_ruled_out", "g2_chronic_hbv_hcv_ruled_out", "alt_cause_explains",
    ],
    skill_files: [
      ".claude/skills/chart-review-rucam/references/scoring/item-5-exclusion.md",
      ".claude/skills/chart-review-rucam/references/scoring/item-8-attribution.md",
    ],
    keywords: [
      "HAV", "HBV", "HCV", "hepatitis", "AMA", "ANA", "SMA", "MRCP", "biliary", "obstruction",
      "ERCP", "alcohol", "sepsis", "shock", "ischemia", "CMV", "EBV", "HSV", "autoimmune", "cirrhosis",
    ],
  },
  {
    group_id: "hepatotoxicity",
    title: "Prior hepatotoxicity (item 6)",
    field_ids: ["hepatotoxicity_class"],
    skill_files: [".claude/skills/chart-review-rucam/references/scoring/item-6-hepatotoxicity.md"],
    keywords: ["hepatotoxic", "drug-induced", "DILI", "LiverTox"],
  },
  {
    group_id: "rechallenge",
    title: "Rechallenge (item 7)",
    field_ids: ["rechallenge_result"],
    skill_files: [".claude/skills/chart-review-rucam/references/scoring/item-7-rechallenge.md"],
    keywords: ["rechallenge", "re-exposure", "restarted", "resumed", "readministered"],
  },
];

// NOTE: RUCAM no longer uses per-item scoring. The rubric was decomposed so the
// agent extracts 24 component leaves (onset_path, dechallenge_outcome, the
// g1_*/g2_* exclusion flags, …) and the platform DERIVES item_1…item_7, the
// total, and the category from them. The old per-item loop (one conversation per
// item, retrying until item_N's field is written) pointed the agent at the now-
// DERIVED item fields — which are guard-rejected — and forced parallel tool calls,
// which hung the deepagents stack on the resulting rejection storms. So RUCAM runs
// as a single-pass extraction (the sidecar's non-per_item path), serial tool calls.
// The `perItem` mechanism (PerItemSpec / ToolProfile.perItem / sidecar _score_items)
// is retained but unused, in case a future task wants genuine per-item invocation.

/** Named profiles for tasks that bring their own tools, keyed by meta.yaml's
 *  `tool_profile`. Add an entry when a task needs bespoke tools. */
const NAMED_PROFILES: Record<string, Partial<ToolProfile>> = {
  rucam: {
    // Hybrid: write/note tools stay in baseTools (MCP); read/compute tools are
    // sidecar Python plugins reused from RUCAM/agent_v2/tools.py.
    pythonPlugins: ["chart_review_plugins.rucam"],
    dataSource: "rucam-csv",
    skills: ["rucam-scoring"],
    // Grouped/compacted invocation: foundations computed once, then one short
    // fresh conversation per group of leaves (see RUCAM_GROUPS). Cuts the
    // super-linear context growth of the single all-24-leaves conversation while
    // keeping cross-item coherence within each group. Targets leaves + stays
    // serial, so it avoids the derived-field/parallel pitfalls that retired perItem.
    perGroup: RUCAM_GROUPS,
    // No perItem: RUCAM is decomposed — items derived. (perGroup supersedes the
    // old single-pass path for RUCAM.)
    // Also expose read_structured_data/list_structured_data: the patient's
    // labs/meds/conditions are materialized into omop/, so the agent can cite
    // CITABLE structured rows ({source:"structured", table, row_id}) that resolve
    // to what the reviewer sees — instead of falling back to a note. The plugin
    // tools remain for the COMPUTED parts (R-ratio, exclusion floor, drug episodes).
    structuredData: true,
  },
  // Proof hook: a phenotype task with `tool_profile: _demo` loads the fixture
  // plugin (chart_review_plugins._demo) so the registry→runspec→sidecar→agent
  // chain can be exercised end-to-end. Not for real tasks.
  _demo: {
    pythonPlugins: ["chart_review_plugins._demo"],
  },
};

/** Resolve a task to its tool profile. A task with no `tool_profile` resolves to
 *  the kind default (today's behavior — backward compatible). */
export function toolProfileFor(task: CompiledTask & { tool_profile?: string }): ToolProfile {
  const kind = task.task_kind ?? "phenotype";
  const base: ToolProfile = {
    baseTools: kind === "adherence" ? ADHERENCE_BASE_TOOLS : PHENOTYPE_BASE_TOOLS,
    structuredData: task.uses_structured_data === true,
    mcpTools: [],
    pythonPlugins: [],
    skills: [],
    dataSource: "omop",
  };
  const named = task.tool_profile ? NAMED_PROFILES[task.tool_profile] : undefined;
  const profile = named ? { ...base, ...named } : base;
  // Grouped/compacted invocation is OPT-IN (CHART_REVIEW_RUCAM_GROUP), NOT the
  // default. Measured 2026-07-13 on patient_real_rucam_01 (gpt-5.2): grouped used
  // 2.14x the input tokens / ~2.4x the cost of single-pass. Reason: with prompt
  // caching the single growing conversation is ~96% cached (nearly free), so
  // compacting context saves little — while grouping triples the turn count (each
  // re-paying system+tool-schema overhead) and re-reads skill files + re-sweeps
  // notes per group (uncached). So single-pass is the default; the grouped
  // machinery (RUCAM_GROUPS / sidecar _score_groups) stays behind this flag for
  // experimentation (e.g. a backend without caching, or coherence needs).
  if (profile.perGroup && !process.env.CHART_REVIEW_RUCAM_GROUP) delete profile.perGroup;
  return profile;
}

/** The CHART_REVIEW_MCP_TOOLS allowlist a run pins on the subprocess. */
export function mcpAllowlist(p: ToolProfile): string {
  return [
    ...p.baseTools,
    ...(p.structuredData ? STRUCTURED_DATA_TOOLS : []),
    ...p.mcpTools,
  ].join(",");
}

// Tool descriptions + per-task tool resolver (display-ready).
export * from "./descriptions.js";
