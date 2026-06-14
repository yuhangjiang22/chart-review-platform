// refine/adherence-error-analysis.ts — adherence port of the model-vs-human
// error analysis (judge-free). One LLM call per QUESTION: given the question
// text + its retrieval_hints guidance + the agent-vs-reviewer answer
// disagreements, classify rubric_gap / genuine_ambiguity / model_slip and name
// what the question guidance fails to specify. Maps onto the shared
// classification_hint vocabulary so the refiner/card are shared.

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
import { collectAdherenceRefinementCandidates, type AdherenceRefinementExample } from "./adherence-candidates.js";

export interface AnalyzeAdherenceInput {
  taskId: string;
  questionId: string;
  questionText: string;
  retrievalHints: string;
  examples: AdherenceRefinementExample[];
  provider?: ProviderName;
}

export interface AnalyzeAdherenceOutput {
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
  const i = text.indexOf(`<${tag}>`);
  if (i < 0) return null;
  const j = text.indexOf(`</${tag}>`, i + tag.length + 2);
  if (j < 0) return null;
  return text.slice(i + tag.length + 2, j).trim();
}

const PREAMBLE = [
  "You are the chart-review QUESTION error analyst. An adherence agent answered",
  "one chart-review question, and a human reviewer validated a different answer.",
  "The reviewer's validated answer is GROUND TRUTH.",
  "",
  "Your single judgement: would the question (its text + retrieval guidance) AS",
  "WRITTEN lead a careful reviewer to the agent's wrong answers? Choose:",
  "  - rubric_gap        — the question/guidance is silent / underspecified /",
  "                         misleading (e.g. doesn't say WHERE to look, or how to",
  "                         resolve a common ambiguity). It SHOULD change.",
  "  - genuine_ambiguity — the answer is genuinely ambiguous; experts could differ;",
  "                         a clarifying hint would help.",
  "  - model_slip        — the question + guidance are clear and already cover this;",
  "                         the agent simply erred. Do NOT change the guidance.",
  "",
  "Be strict. Reason only from the inline question + examples — do NOT read files.",
  "Emit ONE JSON record wrapped in <ERROR_ANALYSIS>...</ERROR_ANALYSIS>.",
].join("\n");

export function buildAdherenceAnalyzerPrompt(input: AnalyzeAdherenceInput): string {
  return [
    PREAMBLE,
    "",
    `## Question under analysis (task ${input.taskId})`,
    `- question_id: ${input.questionId}`,
    `- text: ${JSON.stringify(input.questionText)}`,
    "### Retrieval guidance (retrieval_hints)",
    input.retrievalHints.trim() || "(none)",
    "",
    `## The ${input.examples.length} answer disagreement(s)`,
    ...input.examples.slice(0, 30).map(
      (e) =>
        `- patient ${e.patient_id}: agent → ${JSON.stringify(e.agent_answer)}, reviewer → ${JSON.stringify(e.reviewer_answer)}${e.excerpt ? ` (cited: ${JSON.stringify(e.excerpt.slice(0, 200))})` : ""}`,
    ),
    "",
    "OUTPUT SCHEMA — exact field names:",
    "<ERROR_ANALYSIS>",
    "{",
    '  "error_class": "rubric_gap" | "genuine_ambiguity" | "model_slip",',
    '  "what_rubric_misses": "<for rubric_gap/ambiguity: 1-2 sentences naming what the question/guidance fails to specify. Empty string for model_slip.>",',
    '  "reasoning": "<1-3 sentences, grounded in the question vs the answers>"',
    "}",
    "</ERROR_ANALYSIS>",
    "`error_class` and `reasoning` are required.",
  ].join("\n");
}

export async function analyzeAdherenceQuestion(input: AnalyzeAdherenceInput): Promise<AnalyzeAdherenceOutput> {
  const start = Date.now();
  if (!input.examples.length) return { ok: false, error: "no examples provided", duration_ms: Date.now() - start };
  const pid = input.examples[0].patient_id;
  const task = loadCompiledTask(input.taskId);
  const scratch = path.join(PLATFORM_ROOT, "var", "_refine_scratch", `adh-ea-${input.taskId}-${input.questionId}`);
  const mcpServers = task
    ? buildMcpServersConfig(
        pid, task, `adh-error-analysis-${input.taskId}-${input.questionId}`,
        { onStateUpdate: () => {} },
        { reviewsRoot: scratch, provider: input.provider },
      )
    : undefined;

  let resultText = "";
  let cost: number | undefined;
  try {
    for await (const event of runAgent({
      prompt: buildAdherenceAnalyzerPrompt(input),
      cwd: patientDir(pid),
      patientId: pid,
      taskId: input.taskId,
      guidelinePath: guidelineDir(input.taskId),
      mcpServers,
      phi: isPhiPatient(pid),
      maxTurns: 12,
      model: analyzerModel(),
      provider: input.provider,
      extraSystemPrompt:
        "You are the chart-review question error analyst. Produce ONE strict-JSON " +
        "record wrapped in <ERROR_ANALYSIS> sentinels. Reason only from the inline " +
        "question + examples; do not read files, do not commit, do not narrate.",
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
  if (!wrapped) return { ok: false, error: "analyzer response missing <ERROR_ANALYSIS> sentinel", duration_ms: Date.now() - start, cost_usd: cost, model: analyzerModel() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped);
  } catch (e) {
    return { ok: false, error: `analyzer response was not valid JSON: ${(e as Error).message}`, duration_ms: Date.now() - start, cost_usd: cost, model: analyzerModel() };
  }
  const analysis = validateAnalysis(parsed);
  if (!analysis) return { ok: false, error: "analyzer response failed schema validation", duration_ms: Date.now() - start, cost_usd: cost, model: analyzerModel() };
  return { ok: true, analysis, cost_usd: cost, duration_ms: Date.now() - start, model: analyzerModel() };
}

// ── Persistence + batch ────────────────────────────────────────────────────────

export interface AdherenceErrorAnalysisRecord {
  question_id: string;
  classification_hint: "guideline_gap" | "true_ambiguity" | "agent_error";
  error_class: ErrorClass;
  what_rubric_misses: string;
  reasoning: string;
  n_examples: number;
  generated_at: string;
}

export interface AdherenceErrorAnalysesFile {
  iter_id: string;
  task_id: string;
  session_id: string;
  generated_at: string;
  model: string;
  cells_analyzed: number;
  cells_failed: number;
  analyses: AdherenceErrorAnalysisRecord[];
}

function adhErrorAnalysesPath(taskId: string, iterId: string): string {
  return path.join(pilotIterDir(taskId, iterId), "adherence_error_analyses.json");
}

export function readAdherenceErrorAnalyses(taskId: string, iterId: string): AdherenceErrorAnalysesFile | null {
  try {
    return JSON.parse(fs.readFileSync(adhErrorAnalysesPath(taskId, iterId), "utf8")) as AdherenceErrorAnalysesFile;
  } catch {
    return null;
  }
}

export interface RunAdherenceErrorAnalysisResult {
  ok: boolean;
  error?: string;
  cells_analyzed: number;
  cells_failed: number;
  analyses: AdherenceErrorAnalysisRecord[];
}

export async function runAdherenceErrorAnalysisBatch(opts: {
  sessionId: string;
  taskId: string;
  iterId: string;
  provider?: ProviderName;
  now?: string;
}): Promise<RunAdherenceErrorAnalysisResult> {
  const { sessionId, taskId, iterId, provider } = opts;
  const candidates = collectAdherenceRefinementCandidates({ sessionId, taskId, iterId });
  if (candidates.unsupported) {
    return { ok: false, error: candidates.unsupported.reason, cells_analyzed: 0, cells_failed: 0, analyses: [] };
  }

  const analyses: AdherenceErrorAnalysisRecord[] = [];
  let failed = 0;
  let model = analyzerModel() ?? "(unknown)";
  const now = opts.now ?? new Date().toISOString();

  for (const cluster of candidates.clusters) {
    if (cluster.examples.length === 0) continue;
    const out = await analyzeAdherenceQuestion({
      taskId,
      questionId: cluster.question_id,
      questionText: cluster.question_text ?? cluster.question_id,
      retrievalHints: cluster.retrieval_hints ?? "",
      examples: cluster.examples,
      provider,
    });
    if (out.model) model = out.model;
    if (!out.ok || !out.analysis) {
      failed++;
      continue;
    }
    analyses.push({
      question_id: cluster.question_id,
      classification_hint: errorClassToHint(out.analysis.error_class),
      error_class: out.analysis.error_class,
      what_rubric_misses: out.analysis.what_rubric_misses,
      reasoning: out.analysis.reasoning,
      n_examples: cluster.examples.length,
      generated_at: now,
    });
  }

  const file: AdherenceErrorAnalysesFile = {
    iter_id: iterId,
    task_id: taskId,
    session_id: sessionId,
    generated_at: now,
    model,
    cells_analyzed: analyses.length,
    cells_failed: failed,
    analyses,
  };
  atomicWriteText(adhErrorAnalysesPath(taskId, iterId), JSON.stringify(file, null, 2));
  return { ok: true, cells_analyzed: analyses.length, cells_failed: failed, analyses };
}
