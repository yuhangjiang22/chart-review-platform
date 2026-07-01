// Human-readable descriptions for every tool a task can expose, + a resolver
// that turns a task's ToolProfile into a display-ready, grouped tool list.
// One place to answer "what tools does task X use, and what does each do?"
import type { CompiledTask } from "@chart-review/tasks";
import { toolProfileFor, STRUCTURED_DATA_TOOLS, type ToolProfile } from "./index.js";

/** MCP + structured tool id → one-line readable description. */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  // Notes (read) — shared by every agent task
  list_notes: "List the patient's note files (name, date, type).",
  read_note: "Read one note's full text.",
  read_notes: "Read several notes' full text at once.",
  search_notes: "Keyword-search across all of the patient's notes.",
  get_note_section: "Pull just a note's relevant sections (Assessment/Labs/HPI…) — cheaper than full text.",
  // Criteria (phenotype)
  list_criteria: "List the rubric's criteria (the fields to answer).",
  read_criterion: "Read one criterion's definition + extraction guidance.",
  read_criteria: "Read several criteria at once.",
  // Write / evidence (phenotype)
  find_quote_offsets: "Locate a verbatim quote's character offsets in a note (for faithful citation).",
  set_field_assessment: "Commit an answer + rationale + evidence for one criterion (faithfulness-gated write).",
  select_evidence: "Attach/select evidence items for the active criterion.",
  set_summary: "Write a patient-level summary.",
  set_review_status: "Mark the review's status (in_progress / complete…).",
  get_review_state: "Read back the current draft state.",
  recommend_keywords: "Suggest search keywords for the criteria.",
  // NER (bso-ad-ner) — BSO-AD ontology browsers (mirror the benchmark skill)
  list_entity_types: "List the BSO-AD entity-type subtrees (the valid entity_type roots).",
  get_concept_tree: "Browse the concept tree under one entity_type (children + paths).",
  normalize_to_ontology: "Normalize a surface form to a canonical ontology concept_name under an entity_type.",
  locate_in_source: "Locate a span's authoritative character offsets in the note (for faithful citation).",
  // Questions (adherence) — replaces criteria + field-write
  list_questions: "List the adherence questions (by tier).",
  read_question: "Read one question's text, schema, and retrieval hints.",
  set_question_answer: "Commit an answer for one adherence question.",
  get_adherence_state: "Read back the adherence draft (answers committed so far).",
  // Structured (OMOP) — opt-in via uses_structured_data
  list_structured_data: "List the patient's OMOP tables + row counts.",
  read_structured_data: "Read rows (conditions/measurements/drugs…) as citable structured evidence.",
};

/** Python plugin module → the read/compute tools it registers, with descriptions.
 *  The TS registry only knows the module path; this maps it to its tools. */
export const PLUGIN_TOOLS: Record<string, Array<{ id: string; description: string }>> = {
  "chart_review_plugins.rucam": [
    { id: "get_patient_summary", description: "Patient-level RUCAM flags/summary." },
    { id: "get_suspect_drug", description: "The suspect drug + first-exposure date." },
    { id: "get_medications", description: "All medications with timing offsets." },
    { id: "get_drug_episodes", description: "Drug start/stop episodes (45-day merge)." },
    { id: "get_lft_series", description: "Liver-function test time series (ALT/AST/ALP/bilirubin)." },
    { id: "get_lab_extremum", description: "Min/max lab value within a window." },
    { id: "get_serology", description: "Viral / serology lab results." },
    { id: "get_conditions", description: "Comorbidity diagnoses." },
    { id: "get_hepatotoxicity_category", description: "LiverTox hepatotoxicity tier for the drug." },
    { id: "compute_r_ratio", description: "R = (ALT/ULN)/(ALP/ULN) → injury type (hepatocellular/cholestatic/mixed)." },
    { id: "score_item5_exclusion", description: "Deterministic exclusion-floor for RUCAM item 5." },
  ],
  "chart_review_plugins._demo": [
    { id: "_demo_echo", description: "Fixture tool — proves the registry→sidecar plugin chain end-to-end." },
  ],
};

export interface ToolInfo { id: string; description: string }
export interface ToolGroup { source: "mcp" | "structured" | "plugin"; label: string; tools: ToolInfo[] }
export interface TaskToolsView {
  task_id: string;
  task_kind: string;
  /** present only when the task declares a per-item invocation (e.g. RUCAM). */
  per_item_count?: number;
  groups: ToolGroup[];
}

const describe = (id: string): string => TOOL_DESCRIPTIONS[id] ?? "(no description)";

/** Resolve a task to a display-ready, grouped tool list with descriptions. */
export function describeTaskTools(task: CompiledTask & { tool_profile?: string }): TaskToolsView {
  const profile: ToolProfile = toolProfileFor(task);
  const groups: ToolGroup[] = [];

  const mcp = [...profile.baseTools, ...profile.mcpTools];
  if (mcp.length) {
    groups.push({
      source: "mcp",
      label: task.task_kind === "adherence"
        ? "MCP tools — notes + questions + write"
        : task.task_kind === "ner"
        ? "NER tools — BSO-AD ontology lookup"
        : "MCP tools — notes + criteria + write",
      tools: mcp.map((id) => ({ id, description: describe(id) })),
    });
  }
  if (profile.structuredData) {
    groups.push({
      source: "structured",
      label: "Structured (OMOP) read tools",
      tools: STRUCTURED_DATA_TOOLS.map((id) => ({ id, description: describe(id) })),
    });
  }
  for (const mod of profile.pythonPlugins) {
    groups.push({
      source: "plugin",
      label: `Python plugin — ${mod}`,
      tools: PLUGIN_TOOLS[mod] ?? [{ id: mod, description: "(plugin tools not catalogued)" }],
    });
  }

  return {
    task_id: task.task_id,
    task_kind: task.task_kind ?? "phenotype",
    ...(profile.perItem ? { per_item_count: profile.perItem.length } : {}),
    groups,
  };
}
