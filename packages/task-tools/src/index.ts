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

const RUCAM_PER_ITEM: PerItemSpec[] = [
  { field_id: "item_1_time_to_onset", item_number: 1,
    skill_file: "/chart-review-rucam/references/scoring/item-1-onset.md",
    keywords: ["started", "initiated", "first dose", "began", "started taking"] },
  { field_id: "item_2_course", item_number: 2,
    skill_file: "/chart-review-rucam/references/scoring/item-2-cessation.md",
    keywords: ["discontinued", "stopped", "held", "dechallenge", "improved", "resolved"] },
  { field_id: "item_3_risk_factors", item_number: 3,
    skill_file: "/chart-review-rucam/references/scoring/item-3-risk-factors.md",
    keywords: ["alcohol", "ethanol", "pregnan", "age"] },
  { field_id: "item_4_concomitant", item_number: 4,
    skill_file: "/chart-review-rucam/references/scoring/item-4-concomitant.md",
    keywords: ["concomitant", "acetaminophen", "tylenol", "augmentin", "statin", "herbal", "supplement"] },
  { field_id: "item_5_exclusion", item_number: 5,
    skill_file: "/chart-review-rucam/references/scoring/item-5-exclusion.md",
    keywords: ["sepsis", "ischemia", "shock", "biliary", "obstruction", "ERCP", "alcohol",
               "hepatitis", "HAV", "HBV", "HCV", "CMV", "EBV", "cirrhosis", "PBC", "PSC",
               "autoimmune", "ANA", "AMA"] },
  { field_id: "item_6_hepatotoxicity", item_number: 6,
    skill_file: "/chart-review-rucam/references/scoring/item-6-hepatotoxicity.md",
    keywords: ["hepatotoxic", "drug-induced", "DILI", "liver injury", "prior reaction"] },
  { field_id: "item_7_rechallenge", item_number: 7,
    skill_file: "/chart-review-rucam/references/scoring/item-7-rechallenge.md",
    keywords: ["rechallenge", "re-started", "resumed", "readministered", "re-exposure"] },
];

/** Named profiles for tasks that bring their own tools, keyed by meta.yaml's
 *  `tool_profile`. Add an entry when a task needs bespoke tools. */
const NAMED_PROFILES: Record<string, Partial<ToolProfile>> = {
  rucam: {
    // Hybrid: write/note tools stay in baseTools (MCP); read/compute tools are
    // sidecar Python plugins reused from RUCAM/agent_v2/tools.py.
    pythonPlugins: ["chart_review_plugins.rucam"],
    dataSource: "rucam-csv",
    skills: ["rucam-scoring"],
    perItem: RUCAM_PER_ITEM,
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
