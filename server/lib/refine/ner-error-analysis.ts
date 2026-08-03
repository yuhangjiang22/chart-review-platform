// refine/ner-error-analysis.ts — NER port of the model-vs-human error analysis.
//
// Same idea as the phenotype error analyst, one unit up: instead of one
// (patient, field) scalar mismatch, the input is one ENTITY TYPE's cluster of
// span disagreements (over/under-extraction, concept, type) between the agent
// drafts and the reviewer's validated spans. The analyst decides whether the
// entity-type GUIDANCE as written would lead a careful annotator to the agent's
// errors (rubric_gap / true_ambiguity) or whether the guidance is clear and the
// agent simply slipped (model_slip). Output maps onto the same
// classification_hint vocabulary, so the downstream refiner/card are shared.

import fs from "node:fs";
import path from "node:path";
import { runAgent, type ProviderName } from "../agent-provider.js";
import { modelFor } from "@chart-review/model-config";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";
import { loadCompiledTask } from "@chart-review/tasks";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import { atomicWriteText } from "../criterion-md.js";
import { pilotIterDir } from "../domain/iter/pilots.js";
import { validateAnalysis, errorClassToHint, type ErrorClass, type MismatchAnalysis } from "./error-analysis.js";
import { collectNerRefinementCandidates, type NerRefinementExample } from "./ner-candidates.js";

// ── Public shapes ────────────────────────────────────────────────────────────

export interface AnalyzeNerInput {
  taskId: string;
  entityType: string;
  /** The entity-type guidance text (the `guidance` field of the YAML). */
  guidanceText: string;
  examples: NerRefinementExample[];
  provider?: ProviderName;
}

export interface AnalyzeNerOutput {
  ok: boolean;
  analysis?: MismatchAnalysis;
  error?: string;
  cost_usd?: number;
  duration_ms: number;
  model?: string;
}

function analyzerModel(): string | undefined {
  return modelFor("judge") ?? modelFor("default");
}

function extractSentinel(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = text.indexOf(open);
  if (i < 0) return null;
  const j = text.indexOf(close, i + open.length);
  if (j < 0) return null;
  return text.slice(i + open.length, j).trim();
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const PREAMBLE = [
  "You are the chart-review ENTITY-TYPE error analyst. An NER agent drafted",
  "entity spans for one entity type, and a human reviewer then validated a",
  "different set of spans. The reviewer's validated spans are GROUND TRUTH.",
  "",
  "Below is the entity type's current GUIDANCE plus the span disagreements:",
  "  - over_extraction  — the agent labeled a span the reviewer did NOT keep",
  "  - under_extraction — the reviewer kept a span the agent MISSED",
  "  - concept_mismatch — same span, agent vs reviewer chose a different concept",
  "  - type_mismatch    — same span, different entity type",
  "",
  "Your single judgement: would the GUIDANCE AS WRITTEN lead a careful annotator",
  "to the agent's errors? Choose:",
  "  - rubric_gap        — the guidance is silent / underspecified / misleading on",
  "                         this pattern (e.g. no negative example for an",
  "                         over-extraction the agent keeps making). Guidance SHOULD change.",
  "  - genuine_ambiguity — the spans are genuinely ambiguous; experts could differ;",
  "                         a clarifying rule would help.",
  "  - model_slip        — the guidance ALREADY covers this (e.g. the exact phrase is",
  "                         a listed negative example) and the agent simply erred.",
  "                         Guidance should NOT change.",
  "",
  "Be strict: only rubric_gap/ambiguity if the guidance genuinely fails to",
  "disambiguate. Reason only from the inline guidance + examples — do NOT read",
  "files. Emit ONE JSON record wrapped in <ERROR_ANALYSIS>...</ERROR_ANALYSIS>.",
].join("\n");

function exampleLine(ex: NerRefinementExample): string {
  switch (ex.kind) {
    case "over_extraction":
      return `- OVER-EXTRACTION: agent labeled "${ex.agent_text}" as ${ex.agent_entity_type}/${ex.agent_concept || "(novel)"} — reviewer did NOT keep it.`;
    case "under_extraction":
      return `- UNDER-EXTRACTION (missed): reviewer kept "${ex.human_text}" as ${ex.human_entity_type}/${ex.human_concept || "(novel)"} — agent missed it.`;
    case "concept_mismatch":
      return `- CONCEPT MISMATCH on "${ex.human_text ?? ex.agent_text}": agent → ${ex.agent_concept || "(novel)"}, reviewer → ${ex.human_concept || "(novel)"}.`;
    case "type_mismatch":
      return `- TYPE MISMATCH on "${ex.human_text ?? ex.agent_text}": agent → ${ex.agent_entity_type}, reviewer → ${ex.human_entity_type}.`;
    case "boundary":
      return `- BOUNDARY: agent "${ex.agent_text}" vs reviewer "${ex.human_text}" (overlapping spans, different bounds).`;
  }
}

export function buildNerAnalyzerPrompt(input: AnalyzeNerInput): string {
  return [
    PREAMBLE,
    "",
    "## Entity type under analysis",
    `- task_id: ${input.taskId}`,
    `- entity_type: ${input.entityType}`,
    "",
    "### Current guidance",
    input.guidanceText.trim() || "(empty)",
    "",
    `## The ${input.examples.length} span disagreement(s)`,
    ...input.examples.slice(0, 30).map(exampleLine),
    "",
    "OUTPUT SCHEMA — use these EXACT field names:",
    "<ERROR_ANALYSIS>",
    "{",
    '  "error_class": "rubric_gap" | "genuine_ambiguity" | "model_slip",',
    '  "what_rubric_misses": "<for rubric_gap/ambiguity: 1-2 sentences naming what the guidance fails to specify that allowed these span errors. Empty string for model_slip.>",',
    '  "reasoning": "<1-3 sentences: why, grounded in the guidance vs the spans>"',
    "}",
    "</ERROR_ANALYSIS>",
    "`error_class` and `reasoning` are required.",
  ].join("\n");
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function analyzeNerEntityType(input: AnalyzeNerInput): Promise<AnalyzeNerOutput> {
  const start = Date.now();
  if (!input.examples.length) {
    return { ok: false, error: "no examples provided", duration_ms: Date.now() - start };
  }
  const pid = input.examples[0].patient_id;
  const cwd = patientDir(pid);
  const task = loadCompiledTask(input.taskId);
  const scratch = path.join(PLATFORM_ROOT, "var", "_refine_scratch", `ner-ea-${input.taskId}-${input.entityType}`);
  const mcpServers = task
    ? buildMcpServersConfig(
        pid, task, `ner-error-analysis-${input.taskId}-${input.entityType}`,
        { onStateUpdate: () => {} },
        { reviewsRoot: scratch, provider: input.provider },
      )
    : undefined;

  let resultText = "";
  let cost: number | undefined;
  try {
    for await (const event of runAgent({
      prompt: buildNerAnalyzerPrompt(input),
      cwd,
      patientId: pid,
      taskId: input.taskId,
      guidelinePath: guidelineDir(input.taskId),
      mcpServers,
      phi: isPhiPatient(pid),
      maxTurns: 12,
      model: analyzerModel(),
      provider: input.provider,
      extraSystemPrompt:
        "You are the chart-review entity-type error analyst. Produce ONE strict-JSON " +
        "record wrapped in <ERROR_ANALYSIS> sentinels. Reason only from the inline " +
        "guidance + examples; do not read files, do not commit, do not narrate.",
    })) {
      if (event.type === "result") {
        if (event.result) resultText = event.result;
        if (typeof event.cost_usd === "number") cost = event.cost_usd;
      } else if (event.type === "error") {
        throw new Error(event.error);
      }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message, duration_ms: Date.now() - start, model: analyzerModel() };
  }

  const wrapped = extractSentinel(resultText, "ERROR_ANALYSIS");
  if (!wrapped) {
    return { ok: false, error: "analyzer response missing <ERROR_ANALYSIS> sentinel", duration_ms: Date.now() - start, cost_usd: cost, model: analyzerModel() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped);
  } catch (e) {
    return { ok: false, error: `analyzer response was not valid JSON: ${(e as Error).message}`, duration_ms: Date.now() - start, cost_usd: cost, model: analyzerModel() };
  }
  const analysis = validateAnalysis(parsed);
  if (!analysis) {
    return { ok: false, error: "analyzer response failed schema validation", duration_ms: Date.now() - start, cost_usd: cost, model: analyzerModel() };
  }
  return { ok: true, analysis, cost_usd: cost, duration_ms: Date.now() - start, model: analyzerModel() };
}

// ── Persistence + batch ────────────────────────────────────────────────────────

export interface NerErrorAnalysisRecord {
  entity_type: string;
  classification_hint: "guideline_gap" | "true_ambiguity" | "agent_error";
  error_class: ErrorClass;
  what_rubric_misses: string;
  reasoning: string;
  n_examples: number;
  generated_at: string;
}

export interface NerErrorAnalysesFile {
  iter_id: string;
  task_id: string;
  session_id: string;
  generated_at: string;
  model: string;
  cells_analyzed: number;
  cells_failed: number;
  analyses: NerErrorAnalysisRecord[];
}

function nerErrorAnalysesPath(taskId: string, iterId: string): string {
  return path.join(pilotIterDir(taskId, iterId), "ner_error_analyses.json");
}

export function readNerErrorAnalyses(taskId: string, iterId: string): NerErrorAnalysesFile | null {
  try {
    return JSON.parse(fs.readFileSync(nerErrorAnalysesPath(taskId, iterId), "utf8")) as NerErrorAnalysesFile;
  } catch {
    return null;
  }
}

export interface RunNerErrorAnalysisResult {
  ok: boolean;
  error?: string;
  cells_analyzed: number;
  cells_failed: number;
  analyses: NerErrorAnalysisRecord[];
}

/**
 * Run the NER error-analysis pass over a validated iter: for every entity-type
 * cluster with span disagreements (and a guidance file), classify it and persist
 * to ner_error_analyses.json. One LLM call per entity type. Phenotype/adherence
 * tasks return an error (collectNerRefinementCandidates is ner-gated).
 */
export async function runNerErrorAnalysisBatch(opts: {
  sessionId: string;
  taskId: string;
  iterId: string;
  provider?: ProviderName;
  now?: string;
}): Promise<RunNerErrorAnalysisResult> {
  const { sessionId, taskId, iterId, provider } = opts;
  const candidates = collectNerRefinementCandidates({ sessionId, taskId, iterId });
  if (candidates.unsupported) {
    return { ok: false, error: candidates.unsupported.reason, cells_analyzed: 0, cells_failed: 0, analyses: [] };
  }

  const analyses: NerErrorAnalysisRecord[] = [];
  let failed = 0;
  let model = analyzerModel() ?? "(unknown)";
  const now = opts.now ?? new Date().toISOString();

  for (const cluster of candidates.clusters) {
    if (!cluster.guidance_text || cluster.examples.length === 0) continue;
    const out = await analyzeNerEntityType({
      taskId,
      entityType: cluster.entity_type,
      guidanceText: cluster.guidance_text,
      examples: cluster.examples,
      provider,
    });
    if (out.model) model = out.model;
    if (!out.ok || !out.analysis) {
      failed++;
      continue;
    }
    analyses.push({
      entity_type: cluster.entity_type,
      classification_hint: errorClassToHint(out.analysis.error_class),
      error_class: out.analysis.error_class,
      what_rubric_misses: out.analysis.what_rubric_misses,
      reasoning: out.analysis.reasoning,
      n_examples: cluster.examples.length,
      generated_at: now,
    });
  }

  const file: NerErrorAnalysesFile = {
    iter_id: iterId,
    task_id: taskId,
    session_id: sessionId,
    generated_at: now,
    model,
    cells_analyzed: analyses.length,
    cells_failed: failed,
    analyses,
  };
  atomicWriteText(nerErrorAnalysesPath(taskId, iterId), JSON.stringify(file, null, 2));

  return { ok: true, cells_analyzed: analyses.length, cells_failed: failed, analyses };
}
