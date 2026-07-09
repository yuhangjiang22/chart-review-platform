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
}

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
    // No perItem: RUCAM is decomposed — single-pass leaf extraction, items derived.
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
  return named ? { ...base, ...named } : base;
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
