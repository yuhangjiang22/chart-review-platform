// refine/error-analysis.ts — Task EA1 of the "refine from human annotations"
// increment (supersedes the agent-vs-agent judge gate for refinement attribution).
//
// THE ATTRIBUTION SOURCE. The earlier design joined the judge's per-cell
// classification_hint (judge_analyses.json), but the judge only fires when the
// two DRAFTING agents disagree — it never sees the human's validated answer. So
// the highest-value case to refine — the model is wrong vs the human, and on a
// strong model BOTH agents are wrong the same way (no agent-vs-agent
// disagreement) — is invisible to it.
//
// This pass attributes directly from the model-vs-HUMAN mismatch: given the
// criterion text, the human's cited chart excerpt, the model's answer+rationale,
// and the human's (ground-truth) answer, an LLM decides whether the criterion AS
// WRITTEN would lead a careful reader to the model's wrong answer (→ a rubric
// gap / genuine ambiguity worth refining) or whether the criterion is clear and
// the model simply slipped (→ model_slip; NEVER refine the rubric for that).
//
// Plumbing mirrors propose.ts / judge.ts: runAgent + a strong model + the
// scratch-MCP pattern + sentinel extraction + strict-schema validation. Output
// maps onto the existing classification_hint vocabulary so candidates.ts and
// propose.ts need no change:
//   rubric_gap        → guideline_gap
//   genuine_ambiguity → true_ambiguity
//   model_slip        → agent_error   (dropped by the refiner safeguard)

import fs from "node:fs";
import path from "node:path";
import { runAgent, type ProviderName } from "../agent-provider.js";
import { modelFor } from "@chart-review/model-config";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "@chart-review/patients";
import { phenotypeSkillDir } from "@chart-review/rubric";
import { loadCompiledTask } from "@chart-review/tasks";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import { atomicWriteJson } from "../storage.js";
import { pilotIterDir } from "../domain/iter/pilots.js";
import { collectRefinementCandidates } from "./candidates.js";

// ── Public shapes ────────────────────────────────────────────────────────────

export interface AnalyzeMismatchInput {
  taskId: string;
  fieldId: string;
  /** The criterion's current definition (prompt + definition + extraction
   *  guidance), as assembled by candidates.ts `criterion_def`. */
  criterionDef: string;
  patientId: string;
  /** The human reviewer's validated answer — treated as GROUND TRUTH. */
  humanAnswer: unknown;
  /** The model's drafted answer (the one that disagrees with the human). */
  modelAnswer: unknown;
  /** The model's rationale for its answer, if the draft recorded one. */
  modelRationale?: string | null;
  /** The human's cited note excerpt for this field (the evidence they keyed on). */
  excerpt?: string | null;
  noteId?: string | null;
  /** Provider the cluster's run used (so the analysis inherits the same backend
   *  the judge would). Falls back to the AGENT_PROVIDER default when absent. */
  provider?: ProviderName;
}

/** The judge-vocabulary attribution this pass assigns, plus the gap text the
 *  refiner (S2) will consume as context. */
export type ErrorClass = "rubric_gap" | "genuine_ambiguity" | "model_slip";

export interface MismatchAnalysis {
  error_class: ErrorClass;
  /** What the criterion fails to specify that allowed the model's wrong answer.
   *  Empty/short for model_slip (the criterion is fine). Feeds the refiner ②. */
  what_rubric_misses: string;
  reasoning: string;
}

export interface AnalyzeMismatchOutput {
  ok: boolean;
  analysis?: MismatchAnalysis;
  error?: string;
  cost_usd?: number;
  duration_ms: number;
  model?: string;
}

/** Collapse error_class → the existing classification_hint vocabulary so the
 *  rest of the refine pipeline (candidates clustering, propose's REFINABLE
 *  filter) is unchanged. */
export function errorClassToHint(
  c: ErrorClass,
): "guideline_gap" | "true_ambiguity" | "agent_error" {
  switch (c) {
    case "rubric_gap":
      return "guideline_gap";
    case "genuine_ambiguity":
      return "true_ambiguity";
    case "model_slip":
      return "agent_error";
  }
}

// ── Model + sentinel plumbing (mirrors propose.ts) ─────────────────────────────

/** Resolve the analyzer model. Reuses the judge slot — same "more capable
 *  triage" need. Resolved at CALL time (dotenv loads after import). */
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

const VALID_CLASSES = new Set<ErrorClass>([
  "rubric_gap",
  "genuine_ambiguity",
  "model_slip",
]);

/** Validate the parsed object conforms to MismatchAnalysis. */
export function validateAnalysis(parsed: unknown): MismatchAnalysis | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.error_class !== "string" || !VALID_CLASSES.has(o.error_class as ErrorClass)) {
    return null;
  }
  if (typeof o.reasoning !== "string" || !o.reasoning.trim()) return null;
  const what =
    typeof o.what_rubric_misses === "string" ? o.what_rubric_misses.trim() : "";
  return {
    error_class: o.error_class as ErrorClass,
    what_rubric_misses: what,
    reasoning: o.reasoning.trim(),
  };
}

// ── Prompt construction ──────────────────────────────────────────────────────

const PROMPT_PREAMBLE = [
  "You are the chart-review ERROR ANALYST. A drafting agent answered one",
  "criterion of a clinical chart-review rubric, and a human reviewer then",
  "validated a DIFFERENT answer. The human's validated answer is GROUND TRUTH.",
  "",
  "Your single judgement: would the criterion AS WRITTEN lead a careful,",
  "competent reader to the model's (wrong) answer? Decide between:",
  "  - rubric_gap        — the criterion is silent / underspecified / misleading",
  "                         on this kind of case, so a careful reader could land",
  "                         on the model's wrong answer. The RUBRIC should change.",
  "  - genuine_ambiguity — the case is genuinely ambiguous; reasonable experts",
  "                         could answer either way; the criterion can't fully",
  "                         resolve it but a clarifying rule would help.",
  "  - model_slip        — the criterion is CLEAR and already covers this case;",
  "                         the model simply erred. The RUBRIC should NOT change.",
  "",
  "Be strict: only call it rubric_gap/ambiguity if the criterion text genuinely",
  "fails to disambiguate. If the criterion already states the rule the model",
  "violated, it is a model_slip — do not invent a rubric gap to excuse a model",
  "error. Refining the rubric for a model slip pollutes the guideline.",
  "",
  "Everything you need is INLINE below — do NOT read the patient chart or any",
  "files. Emit ONE JSON record wrapped in <ERROR_ANALYSIS>...</ERROR_ANALYSIS>",
  "sentinels. Read-only — never commit, edit, or narrate outside the sentinels.",
].join("\n");

export function buildAnalyzerPrompt(input: AnalyzeMismatchInput): string {
  const excerpt = (input.excerpt ?? "").slice(0, 800);
  const lines = [
    PROMPT_PREAMBLE,
    "",
    "## Criterion under analysis",
    `- task_id: ${input.taskId}`,
    `- field_id: ${input.fieldId}`,
    "",
    "### Current criterion definition (prompt + definition + extraction guidance)",
    input.criterionDef.trim() || "(empty)",
    "",
    "## The mismatch",
    `- patient: ${input.patientId}`,
    `- human-cited note excerpt${input.noteId ? ` (${input.noteId})` : ""}: ${
      excerpt ? JSON.stringify(excerpt) : "(no reviewer-cited excerpt)"
    }`,
    `- MODEL answered: ${JSON.stringify(input.modelAnswer)}`,
    `- model's rationale: ${
      input.modelRationale ? JSON.stringify(input.modelRationale.slice(0, 600)) : "(none recorded)"
    }`,
    `- HUMAN (ground-truth) answer: ${JSON.stringify(input.humanAnswer)}`,
    "",
    "## Output",
    "Emit the strict-JSON record. No preamble, no markdown, no commentary outside",
    "the sentinels.",
    "",
    "OUTPUT SCHEMA — use these EXACT field names (the platform validates them):",
    "<ERROR_ANALYSIS>",
    "{",
    '  "error_class": "rubric_gap" | "genuine_ambiguity" | "model_slip",',
    '  "what_rubric_misses": "<for rubric_gap/ambiguity: 1-2 sentences naming what the criterion fails to specify that allowed the wrong answer. Empty string for model_slip.>",',
    '  "reasoning": "<1-3 sentences: why you chose this class, grounded in the criterion text vs the case>"',
    "}",
    "</ERROR_ANALYSIS>",
    "`error_class` and `reasoning` are required.",
  ];
  return lines.join("\n");
}

// ── Entry point ────────────────────────────────────────────────────────────────

/**
 * Analyze ONE model-vs-human mismatch. Returns the attribution + the gap text,
 * or an error on schema miss / agent failure (mirrors judgeCell / proposeRubricEdit).
 */
export async function analyzeMismatch(
  input: AnalyzeMismatchInput,
): Promise<AnalyzeMismatchOutput> {
  const start = Date.now();

  // The deepagents provider always requires a chart_review_state MCP config (it
  // spawns the stdio server). This is a pure reasoning call — it reads nothing —
  // so we point it at a throwaway scratch reviewsRoot, exactly like judgeCell /
  // proposeRubricEdit. The mismatch's patient supplies the cwd/patient context
  // the provider expects; the prompt forbids reading it.
  const pid = input.patientId;
  const cwd = patientDir(pid);
  const guidelinePath = phenotypeSkillDir(input.taskId);
  const task = loadCompiledTask(input.taskId);
  const scratch = path.join(
    PLATFORM_ROOT, "var", "_refine_scratch", `ea-${input.taskId}-${input.fieldId}`,
  );
  const mcpServers = task
    ? buildMcpServersConfig(
        pid, task, `error-analysis-${input.taskId}-${input.fieldId}`,
        { onStateUpdate: () => {} },
        { reviewsRoot: scratch, provider: input.provider },
      )
    : undefined;

  let resultText = "";
  let cost: number | undefined;

  try {
    for await (const event of runAgent({
      prompt: buildAnalyzerPrompt(input),
      cwd,
      patientId: pid,
      taskId: input.taskId,
      guidelinePath,
      mcpServers,
      phi: isPhiPatient(pid),
      maxTurns: 12,
      model: analyzerModel(),
      provider: input.provider,
      extraSystemPrompt:
        "You are the chart-review error analyst. Produce ONE strict-JSON record " +
        "wrapped in <ERROR_ANALYSIS> sentinels. Reason only from the inline " +
        "criterion + mismatch; do not read files, do not commit, do not narrate.",
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
    return {
      ok: false,
      error: "analyzer response missing <ERROR_ANALYSIS> sentinel",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: analyzerModel(),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped);
  } catch (e) {
    return {
      ok: false,
      error: `analyzer response was not valid JSON: ${(e as Error).message}`,
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: analyzerModel(),
    };
  }
  const analysis = validateAnalysis(parsed);
  if (!analysis) {
    return {
      ok: false,
      error: "analyzer response failed schema validation",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: analyzerModel(),
    };
  }

  return { ok: true, analysis, cost_usd: cost, duration_ms: Date.now() - start, model: analyzerModel() };
}

// ── Persistence (mirrors judge_analyses.json) ──────────────────────────────────

/** One persisted per-cell error analysis. `classification_hint` is the collapsed
 *  judge-vocabulary tag so candidates.ts can consume it identically to a judge
 *  record. `reasoning` mirrors the judge's field name for the same reason. */
export interface ErrorAnalysisRecord {
  patient_id: string;
  field_id: string;
  /** Collapsed to the judge vocabulary (guideline_gap / true_ambiguity /
   *  agent_error) so the rest of the refine pipeline is unchanged. */
  classification_hint: "guideline_gap" | "true_ambiguity" | "agent_error";
  /** The raw error_class before collapsing (kept for provenance / the card). */
  error_class: ErrorClass;
  what_rubric_misses: string;
  reasoning: string;
  model_answer: unknown;
  human_answer: unknown;
  error?: string;
  cost_usd?: number;
  duration_ms: number;
  generated_at: string;
}

export interface ErrorAnalysesFile {
  iter_id: string;
  task_id: string;
  session_id: string;
  generated_at: string;
  generated_by: string;
  model: string;
  total_cost_usd: number;
  total_duration_ms: number;
  cells_analyzed: number;
  cells_failed: number;
  analyses: ErrorAnalysisRecord[];
}

function errorAnalysesPath(taskId: string, iterId: string): string {
  return path.join(pilotIterDir(taskId, iterId), "error_analyses.json");
}

/** Read the persisted error analyses for an iter, or null if none yet. */
export function readErrorAnalyses(taskId: string, iterId: string): ErrorAnalysesFile | null {
  try {
    return JSON.parse(fs.readFileSync(errorAnalysesPath(taskId, iterId), "utf8")) as ErrorAnalysesFile;
  } catch {
    return null;
  }
}

export interface RunErrorAnalysisBatchOpts {
  sessionId: string;
  taskId: string;
  iterId: string;
  provider?: ProviderName;
  /** Re-analyze cells that already have a record (default false: skip them). */
  force?: boolean;
}

export interface RunErrorAnalysisBatchResult {
  ok: boolean;
  error?: string;
  cells_analyzed: number;
  cells_failed: number;
  cells_skipped: number;
  file?: ErrorAnalysesFile;
}

/**
 * Run the error-analysis pass over a validated iter: for every (patient, field)
 * model-vs-human mismatch the agent-vs-agent judge did NOT already attribute
 * (classification_hint "unjudged"), call analyzeMismatch and persist the result
 * to error_analyses.json. One cell per (patient, field) — if both agents made
 * the same mistake, it's still one rubric question.
 *
 * Phenotype-gated (collectRefinementCandidates returns `unsupported` otherwise).
 * Merges with any existing error_analyses.json (incremental), unless `force`.
 */
export async function runErrorAnalysisBatch(
  opts: RunErrorAnalysisBatchOpts,
): Promise<RunErrorAnalysisBatchResult> {
  const { sessionId, taskId, iterId, provider, force } = opts;

  const candidates = collectRefinementCandidates({ sessionId, taskId, iterId });
  if (candidates.unsupported) {
    return {
      ok: false,
      error: candidates.unsupported.reason,
      cells_analyzed: 0,
      cells_failed: 0,
      cells_skipped: 0,
    };
  }

  // Existing records (incremental) keyed by cell.
  const existing = readErrorAnalyses(taskId, iterId);
  const byCell = new Map<string, ErrorAnalysisRecord>();
  if (existing && !force) {
    for (const r of existing.analyses ?? []) byCell.set(`${r.patient_id}::${r.field_id}`, r);
  }

  // One mismatch cell per (patient, field): only those the judge left "unjudged"
  // (the systematic-gap case). A cell already attributed by the agent-vs-agent
  // judge keeps that attribution.
  interface Cell {
    patient_id: string;
    field_id: string;
    criterion_def: string;
    model_answer: unknown;
    human_answer: unknown;
    excerpt: string | null;
    note_id: string | null;
  }
  const cells = new Map<string, Cell>();
  for (const cluster of candidates.clusters) {
    if (!cluster.criterion_def) continue;
    for (const ex of cluster.examples) {
      if (ex.classification_hint !== "unjudged") continue; // judge already attributed it
      const key = `${ex.patient_id}::${cluster.field_id}`;
      if (cells.has(key)) continue; // one cell per (patient, field)
      cells.set(key, {
        patient_id: ex.patient_id,
        field_id: cluster.field_id,
        criterion_def: cluster.criterion_def,
        model_answer: ex.agent_answer,
        human_answer: ex.reviewer_answer,
        excerpt: ex.excerpt,
        note_id: ex.note_id,
      });
    }
  }

  let analyzed = 0;
  let failed = 0;
  let skipped = 0;
  let totalCost = 0;
  let totalDur = 0;
  let model = analyzerModel() ?? "(unknown)";

  for (const [key, cell] of cells) {
    if (byCell.has(key) && !force) {
      skipped++;
      continue;
    }
    const out = await analyzeMismatch({
      taskId,
      fieldId: cell.field_id,
      criterionDef: cell.criterion_def,
      patientId: cell.patient_id,
      humanAnswer: cell.human_answer,
      modelAnswer: cell.model_answer,
      excerpt: cell.excerpt,
      noteId: cell.note_id,
      provider,
    });
    totalDur += out.duration_ms;
    if (out.model) model = out.model;
    if (!out.ok || !out.analysis) {
      failed++;
      continue;
    }
    totalCost += out.cost_usd ?? 0;
    analyzed++;
    byCell.set(key, {
      patient_id: cell.patient_id,
      field_id: cell.field_id,
      classification_hint: errorClassToHint(out.analysis.error_class),
      error_class: out.analysis.error_class,
      what_rubric_misses: out.analysis.what_rubric_misses,
      reasoning: out.analysis.reasoning,
      model_answer: cell.model_answer,
      human_answer: cell.human_answer,
      cost_usd: out.cost_usd,
      duration_ms: out.duration_ms,
      generated_at: new Date().toISOString(),
    });
  }

  const file: ErrorAnalysesFile = {
    iter_id: iterId,
    task_id: taskId,
    session_id: sessionId,
    generated_at: new Date().toISOString(),
    generated_by: "error-analysis-batch",
    model,
    total_cost_usd: totalCost,
    total_duration_ms: totalDur,
    cells_analyzed: analyzed,
    cells_failed: failed,
    analyses: [...byCell.values()],
  };
  atomicWriteJson(errorAnalysesPath(taskId, iterId), file);

  return { ok: true, cells_analyzed: analyzed, cells_failed: failed, cells_skipped: skipped, file };
}
