// judge.ts — LLM-as-judge for a single (patient, criterion) cell.
//
// Modeled on override-suggester.ts: a one-shot agent query that activates
// the chart-review-judge skill, reads the chart + criterion, and returns
// a strict-JSON analysis. The reviewer sees this in the VALIDATE form
// before they adjudicate — the judge does NOT commit answers.
//
// Two cell shapes feed in:
//   - "disagreement" — two agents disagreed on a leaf field
//   - "low_confidence" — one agent reported `confidence: "low"`
//
// Output schema is documented in .claude/skills/chart-review-judge/SKILL.md.

import path from "path";
import { runAgent, type ProviderName } from "./agent-provider.js";
import { modelFor } from "./model-config.js";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "./patients.js";
import { phenotypeSkillDir } from "./domain/rubric/index.js";
import { loadCompiledTask } from "./tasks.js";
import { buildMcpServersConfig } from "./mcp-tools.js";
import type { EvidenceRef, FieldAssessment } from "./disagreements.js";

/** Per-agent snapshot the judge sees (one for each side of a disagreement,
 *  or just one for a low-confidence single-agent cell). */
export interface JudgeAgentSnapshot {
  agent_id: string;
  answer: unknown;
  confidence?: "low" | "medium" | "high";
  rationale?: string;
  evidence?: EvidenceRef[];
}

export interface JudgeInput {
  patientId: string;
  taskId: string;
  fieldId: string;
  /**
   * "disagreement" — agents normalized to different answers (real semantic disagreement).
   * "low_confidence" — single-agent cell with confidence: "low".
   * "type_drift" — both agents agreed semantically (post-normalization) but emitted
   *   different raw value formats (e.g. boolean true vs string "yes"). The judge's
   *   job here is to identify the canonical form per the criterion's answer_schema —
   *   not to pick a clinical answer (agents already agree).
   */
  kind: "disagreement" | "low_confidence" | "type_drift";
  agent_a: JudgeAgentSnapshot;
  agent_b?: JudgeAgentSnapshot;
  /** Provider to run the judge on. The caller passes the provider that
   *  produced the run being judged so judge inherits the same backend
   *  (Claude run → Claude judge, Codex run → Codex judge). When absent,
   *  falls back to the AGENT_PROVIDER env-var default. */
  provider?: ProviderName;
}

/** Strict-JSON schema the skill is instructed to emit. */
export interface JudgeAnalysis {
  suggested_answer: unknown;
  reasoning: string;
  evidence_pointers: Array<{
    note_id: string;
    what_to_look_for: string;
    offsets?: [number, number] | null;
  }>;
  agent_correctness: "agent_a" | "agent_b" | "neither" | "both" | "n_a";
  classification_hint:
    | "guideline_gap"
    | "agent_a_error"
    | "agent_b_error"
    | "true_ambiguity"
    | "n_a";
  judge_confidence: "low" | "medium" | "high";
}

export interface JudgeOutput {
  ok: boolean;
  analysis?: JudgeAnalysis;
  error?: string;
  cost_usd?: number;
  duration_ms: number;
  model?: string;
}

/** Resolve the judge model via the shared model-config seam. The judge
 *  typically runs Sonnet (more capable triage) while the per-patient
 *  agents run Haiku (cheaper); operators override via
 *  CHART_REVIEW_JUDGE_MODEL or by editing model-config.ts DEFAULTS. */
// Resolve the judge model at CALL time, not module-load time: this module is
// imported (transitively) before server/index.ts runs dotenv.config(), so a
// top-level const would capture the fallback before CHART_REVIEW_JUDGE_MODEL
// is loaded from .env.
function judgeModel(): string | undefined {
  return modelFor("judge") ?? modelFor("default");
}

const PROMPT_PREAMBLE = [
  "Activate the `chart-review-judge` skill via the Skill tool. Operate in",
  "structured-output mode: read the chart, form your own opinion on what",
  "the right answer is, and emit ONE JSON record wrapped in",
  "<JUDGE_ANALYSIS>...</JUDGE_ANALYSIS> sentinels. Read-only — never",
  "commit answers via any tool.",
  "",
  "If a `chart-review-<task>-phenotype` skill exists, activate it too — it",
  "carries the criterion definitions and edge cases.",
].join("\n");

function extractSentinel(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = text.indexOf(open);
  if (i < 0) return null;
  const j = text.indexOf(close, i + open.length);
  if (j < 0) return null;
  return text.slice(i + open.length, j).trim();
}

/** Validate that an arbitrary parsed object conforms to JudgeAnalysis.
 *  Returns the typed object on success, or null with reason logged. */
function validateAnalysis(parsed: unknown): JudgeAnalysis | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.reasoning !== "string") return null;
  if (!Array.isArray(o.evidence_pointers)) return null;
  const validJC = ["low", "medium", "high"];
  if (typeof o.judge_confidence !== "string" || !validJC.includes(o.judge_confidence)) return null;
  const validAC = ["agent_a", "agent_b", "neither", "both", "n_a"];
  if (typeof o.agent_correctness !== "string" || !validAC.includes(o.agent_correctness)) return null;
  const validCH = ["guideline_gap", "agent_a_error", "agent_b_error", "true_ambiguity", "n_a"];
  if (typeof o.classification_hint !== "string" || !validCH.includes(o.classification_hint)) return null;
  // suggested_answer can be any value (or null) — schema is per-criterion
  // and validated downstream when the reviewer accepts the suggestion.
  return {
    suggested_answer: o.suggested_answer,
    reasoning: o.reasoning,
    evidence_pointers: (o.evidence_pointers as unknown[]).map((p) => {
      const pp = (p ?? {}) as Record<string, unknown>;
      return {
        note_id: typeof pp.note_id === "string" ? pp.note_id : "",
        what_to_look_for:
          typeof pp.what_to_look_for === "string" ? pp.what_to_look_for : "",
        offsets:
          Array.isArray(pp.offsets) && pp.offsets.length === 2
            ? ([Number(pp.offsets[0]), Number(pp.offsets[1])] as [number, number])
            : null,
      };
    }),
    agent_correctness: o.agent_correctness as JudgeAnalysis["agent_correctness"],
    classification_hint: o.classification_hint as JudgeAnalysis["classification_hint"],
    judge_confidence: o.judge_confidence as JudgeAnalysis["judge_confidence"],
  };
}

function snapshotBlock(label: string, snap: JudgeAgentSnapshot): string {
  const evidenceLines = (snap.evidence ?? [])
    .slice(0, 5) // cap to keep prompt small
    .map((e, i) => {
      const note = e.note_id ?? "(unknown note)";
      const off =
        Array.isArray(e.span_offsets) && e.span_offsets.length === 2
          ? ` [${e.span_offsets[0]}-${e.span_offsets[1]}]`
          : "";
      const q = (e.verbatim_quote ?? "").slice(0, 200);
      return `  ${i + 1}. ${note}${off}: "${q}"`;
    })
    .join("\n");
  return [
    `## ${label} (${snap.agent_id})`,
    `- answer: ${JSON.stringify(snap.answer)}`,
    `- confidence: ${snap.confidence ?? "(unspecified)"}`,
    `- rationale: ${snap.rationale ?? "(none)"}`,
    `- evidence cited:`,
    evidenceLines || "  (none)",
  ].join("\n");
}

function buildUserPrompt(input: JudgeInput): string {
  const cwd = patientDir(input.patientId);
  const skill = phenotypeSkillDir(input.taskId);
  const criterionPath = path.join(skill, "references", "criteria", `${input.fieldId}.md`);
  const isTwoAgent = input.kind === "disagreement" || input.kind === "type_drift";
  const aLabel = isTwoAgent ? "Agent A draft" : "Single agent draft";
  const lines = [
    PROMPT_PREAMBLE,
    "",
    "## Cell to judge",
    `- patient_id: ${input.patientId}`,
    `- task_id: ${input.taskId}`,
    `- field_id: ${input.fieldId}`,
    `- kind: ${input.kind}`,
    "",
    "## Read these files",
    `- criterion definition: ${criterionPath}`,
    `- patient notes folder: ${cwd}/notes/`,
    `- phenotype skill (for edge cases): ${path.relative(PLATFORM_ROOT, skill)}/`,
    "",
    snapshotBlock(aLabel, input.agent_a),
  ];
  if (isTwoAgent && input.agent_b) {
    lines.push("");
    lines.push(snapshotBlock("Agent B draft", input.agent_b));
  }
  lines.push("");
  if (input.kind === "type_drift") {
    lines.push(
      "NOTE: this is a type_drift cell — the agents agreed semantically but",
      "emitted different value formats (e.g. boolean true vs string 'yes').",
      "Your job is NOT to pick a clinical answer (the agents already agree).",
      "Identify the canonical form per the criterion's answer_schema, and",
      "explain that this is a format/data-quality issue rather than a",
      "clinical or guideline disagreement.",
      "",
    );
  }
  lines.push(
    "Now read the chart + criterion + edge cases, form your own opinion, and",
    "emit the strict-JSON analysis inside <JUDGE_ANALYSIS> sentinels. No",
    "preamble, no markdown, no commentary outside the sentinels.",
    "",
    "OUTPUT SCHEMA — use these EXACT field names (the platform validates them;",
    "do NOT rename to judge_answer/judge_rationale or omit any field):",
    "<JUDGE_ANALYSIS>",
    "{",
    '  "suggested_answer": <the answer you believe correct — a value from the criterion\'s answer_schema, or null if truly ambiguous>,',
    '  "reasoning": "<2-4 sentences, quoting evidence where possible>",',
    '  "evidence_pointers": [ { "note_id": "<file>", "what_to_look_for": "<phrase>", "offsets": [start,end] } ],',
    '  "agent_correctness": "agent_a" | "agent_b" | "neither" | "both" | "n_a",',
    '  "classification_hint": "guideline_gap" | "agent_a_error" | "agent_b_error" | "true_ambiguity" | "n_a",',
    '  "judge_confidence": "low" | "medium" | "high"',
    "}",
    "</JUDGE_ANALYSIS>",
    "evidence_pointers may be an empty array []. Every other field is required.",
  );
  return lines.join("\n");
}

/**
 * Run the judge on one cell. Synchronous API (collects the full streamed
 * response). For batch use, see judge-batch.ts.
 */
export async function judgeCell(input: JudgeInput): Promise<JudgeOutput> {
  const start = Date.now();
  const cwd = patientDir(input.patientId);
  const guidelinePath = phenotypeSkillDir(input.taskId);

  // The deepagents provider always requires a chart_review_state MCP config
  // (it spawns the stdio server to serve the chart). The judge is read-only —
  // it reads notes/criteria via the MCP tools and never commits — so point it
  // at a throwaway scratch reviewsRoot (any set_* write the judge might make is
  // discarded). Without this, the provider rejects the run.
  const task = loadCompiledTask(input.taskId);
  const judgeScratch = path.join(
    PLATFORM_ROOT, "var", "_judge_scratch", `${input.patientId}-${input.fieldId}`,
  );
  const mcpServers = task
    ? buildMcpServersConfig(
        input.patientId, task, `judge-${input.patientId}-${input.fieldId}`,
        { onStateUpdate: () => {} },
        { reviewsRoot: judgeScratch, provider: input.provider },
      )
    : undefined;

  let resultText = "";
  let cost: number | undefined;

  try {
    for await (const event of runAgent({
      prompt: buildUserPrompt(input),
      cwd,
      patientId: input.patientId,
      taskId: input.taskId,
      guidelinePath,
      mcpServers,
      phi: isPhiPatient(input.patientId),
      maxTurns: 24,
      model: judgeModel(),
      provider: input.provider,
      extraSystemPrompt:
        "You are the chart-review-judge skill. Produce ONE strict-JSON " +
        "record wrapped in <JUDGE_ANALYSIS> sentinels. Do not commit, " +
        "do not edit, do not narrate.",
    })) {
      if (event.type === "result") {
        if (event.result) resultText = event.result;
        if (typeof event.cost_usd === "number") cost = event.cost_usd;
      } else if (event.type === "error") {
        throw new Error(event.error);
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      duration_ms: Date.now() - start,
      model: judgeModel(),
    };
  }

  const wrapped = extractSentinel(resultText, "JUDGE_ANALYSIS");
  if (!wrapped) {
    return {
      ok: false,
      error: "judge response missing <JUDGE_ANALYSIS> sentinel",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: judgeModel(),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped);
  } catch (e) {
    return {
      ok: false,
      error: `judge response was not valid JSON: ${(e as Error).message}`,
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: judgeModel(),
    };
  }
  const analysis = validateAnalysis(parsed);
  if (!analysis) {
    return {
      ok: false,
      error: "judge response failed schema validation",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: judgeModel(),
    };
  }
  return {
    ok: true,
    analysis,
    cost_usd: cost,
    duration_ms: Date.now() - start,
    model: judgeModel(),
  };
}

/** Helper: from an agent's full draft, find the FieldAssessment for a given
 *  field_id. Returns null if missing (so callers can skip cleanly). */
export function findFieldAssessment(
  draft: { field_assessments?: FieldAssessment[] },
  fieldId: string,
): FieldAssessment | null {
  return (draft.field_assessments ?? []).find((fa) => fa.field_id === fieldId) ?? null;
}

// ── NER judge (Phase 2.2) ──────────────────────────────────────────
//
// Parallel surface for task_kind="ner" — same runAgent/sentinel/cost
// machinery as judgeCell, but the prompt activates chart-review-ner-judge
// and frames the question around a span (or span pair) instead of a cell.

/** Subset of SpanLabel needed for the judge prompt. Local copy to keep
 *  the judge module free of platform-types coupling. */
export interface JudgeSpanSnapshot {
  agent_id: string;
  note_id: string;
  text: string;
  anchor: string;
  start: number;
  end: number;
  entity_type: string;
  concept_name: string;
  status?: "mapped" | "novel_candidate" | "rejected";
  /** Optional confidence — agents don't currently emit it on spans, but
   *  judges expect the field. Defaults to "(unspecified)" in the prompt. */
  confidence?: "low" | "medium" | "high";
}

export interface JudgeSpanInput {
  patientId: string;
  taskId: string;
  span_id: string;
  note_id: string;
  entity_type: string;
  /**
   * `hard`         — same boundaries + entity_type, different concept_name
   * `soft`         — overlapping spans with concept mismatch
   * `boundary`     — overlapping spans, same concept, different bounds
   * `type_diff`    — same boundaries, different entity_type
   * `miss`         — span on one side only
   * `novel_candidate` — single agent flagged as not-in-ontology
   * `low_confidence`  — single agent emitted with confidence: low
   */
  kind:
    | "hard" | "soft" | "boundary" | "type_diff"
    | "miss" | "novel_candidate" | "low_confidence";
  /** Span as seen by agent A. `null` for miss-only-B. */
  agent_a: JudgeSpanSnapshot | null;
  /** Span as seen by agent B. `null` for miss-only-A or single-agent cases. */
  agent_b?: JudgeSpanSnapshot | null;
  provider?: ProviderName;
}

const SPAN_PROMPT_PREAMBLE = [
  "Activate the `chart-review-ner-judge` skill via the Skill tool. Operate",
  "in structured-output mode: read the note, form your own opinion on the",
  "correct (entity_type, concept_name, status) for this span, and emit ONE",
  "JSON record wrapped in <JUDGE_ANALYSIS>...</JUDGE_ANALYSIS> sentinels.",
  "Read-only — never commit answers via any tool.",
  "",
  "If a `chart-review-<task>` scope skill exists, activate it too — it",
  "carries the ontology + entity-type guidance.",
].join("\n");

function spanSnapshotBlock(label: string, snap: JudgeSpanSnapshot | null | undefined): string {
  if (!snap) {
    return [`## ${label}`, "- (this side did not emit a span at this location)"].join("\n");
  }
  return [
    `## ${label} (${snap.agent_id})`,
    `- text: ${JSON.stringify(snap.text)}`,
    `- anchor: ${JSON.stringify(snap.anchor)}`,
    `- offsets: [${snap.start}, ${snap.end})`,
    `- entity_type: ${snap.entity_type}`,
    `- concept_name: ${JSON.stringify(snap.concept_name)}`,
    `- status: ${snap.status ?? "mapped"}`,
    `- confidence: ${snap.confidence ?? "(unspecified)"}`,
  ].join("\n");
}

function buildSpanJudgePrompt(input: JudgeSpanInput): string {
  const cwd = patientDir(input.patientId);
  const skill = phenotypeSkillDir(input.taskId); // dual-named alias resolves to the task's skill dir for either kind
  const ontologyHint = path.join(skill, "references", "ontology", "concepts.json");
  const isTwoAgent =
    input.kind === "hard" || input.kind === "soft" ||
    input.kind === "boundary" || input.kind === "type_diff";
  const aLabel = isTwoAgent ? "Agent A span" : "Sole agent span";
  const lines = [
    SPAN_PROMPT_PREAMBLE,
    "",
    "## Span to judge",
    `- patient_id: ${input.patientId}`,
    `- task_id: ${input.taskId} (task_kind=ner)`,
    `- span_id: ${input.span_id}`,
    `- note_id: ${input.note_id}`,
    `- entity_type: ${input.entity_type}`,
    `- disagreement_kind: ${input.kind}`,
    "",
    "## Read these files",
    `- note: ${cwd}/notes/${input.note_id}.txt`,
    `- ontology (if present): ${path.relative(PLATFORM_ROOT, ontologyHint)}`,
    `- task skill dir (for entity-type guidance): ${path.relative(PLATFORM_ROOT, skill)}/`,
    "",
    spanSnapshotBlock(aLabel, input.agent_a),
  ];
  if (isTwoAgent) {
    lines.push("", spanSnapshotBlock("Agent B span", input.agent_b ?? null));
  }
  lines.push(
    "",
    "Now read the note + ontology guidance, form your own opinion, and emit",
    "the strict-JSON analysis inside <JUDGE_ANALYSIS> sentinels. No preamble,",
    "no markdown, no commentary outside the sentinels.",
    "",
    "OUTPUT SCHEMA — use these EXACT field names (the platform validates them).",
    "This is the NER-flavored schema: `suggested_concept_name`,",
    "`suggested_entity_type`, and `suggested_status` REPLACE the cell-shaped",
    "`suggested_answer` — do NOT emit `suggested_answer`. Do not rename any",
    "field or omit any required field:",
    "<JUDGE_ANALYSIS>",
    "{",
    '  "suggested_concept_name": "<canonical concept_name from the ontology, or your best candidate label if status is novel_candidate>",',
    '  "suggested_entity_type": "<the entity_type root this span belongs under>",',
    '  "suggested_status": "mapped" | "novel_candidate" | "rejected",',
    '  "reasoning": "<2-4 sentences, quoting evidence where possible>",',
    '  "evidence_pointers": [ { "note_id": "<file>", "what_to_look_for": "<phrase>", "offsets": [start,end] } ],',
    '  "agent_correctness": "agent_a" | "agent_b" | "neither" | "both" | "n_a",',
    '  "classification_hint": "guideline_gap" | "agent_a_error" | "agent_b_error" | "true_ambiguity" | "novel_concept_candidate" | "n_a",',
    '  "judge_confidence": "low" | "medium" | "high"',
    "}",
    "</JUDGE_ANALYSIS>",
    "evidence_pointers may be an empty array []. Every other field is required.",
  );
  return lines.join("\n");
}

/** NER-flavored JudgeAnalysis. Adds suggested_concept_name +
 *  suggested_entity_type + suggested_status; reuses the rest. */
export interface JudgeSpanAnalysis {
  suggested_concept_name: string;
  suggested_entity_type: string;
  suggested_status: "mapped" | "novel_candidate" | "rejected";
  reasoning: string;
  evidence_pointers: Array<{
    note_id: string;
    what_to_look_for: string;
    offsets?: [number, number] | null;
  }>;
  agent_correctness: "agent_a" | "agent_b" | "neither" | "both" | "n_a";
  classification_hint:
    | "guideline_gap"
    | "agent_a_error"
    | "agent_b_error"
    | "true_ambiguity"
    | "novel_concept_candidate"
    | "n_a";
  judge_confidence: "low" | "medium" | "high";
}

export interface JudgeSpanOutput {
  ok: boolean;
  analysis?: JudgeSpanAnalysis;
  error?: string;
  cost_usd?: number;
  duration_ms: number;
  model?: string;
}

function validateSpanAnalysis(parsed: unknown): JudgeSpanAnalysis | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.suggested_concept_name !== "string") return null;
  if (typeof o.suggested_entity_type !== "string") return null;
  const validStatus = ["mapped", "novel_candidate", "rejected"];
  if (typeof o.suggested_status !== "string" || !validStatus.includes(o.suggested_status)) return null;
  if (typeof o.reasoning !== "string") return null;
  if (!Array.isArray(o.evidence_pointers)) return null;
  const validJC = ["low", "medium", "high"];
  if (typeof o.judge_confidence !== "string" || !validJC.includes(o.judge_confidence)) return null;
  const validAC = ["agent_a", "agent_b", "neither", "both", "n_a"];
  if (typeof o.agent_correctness !== "string" || !validAC.includes(o.agent_correctness)) return null;
  const validCH = ["guideline_gap", "agent_a_error", "agent_b_error", "true_ambiguity", "novel_concept_candidate", "n_a"];
  if (typeof o.classification_hint !== "string" || !validCH.includes(o.classification_hint)) return null;
  return {
    suggested_concept_name: o.suggested_concept_name,
    suggested_entity_type: o.suggested_entity_type,
    suggested_status: o.suggested_status as JudgeSpanAnalysis["suggested_status"],
    reasoning: o.reasoning,
    evidence_pointers: (o.evidence_pointers as unknown[]).map((p) => {
      const pp = (p ?? {}) as Record<string, unknown>;
      return {
        note_id: typeof pp.note_id === "string" ? pp.note_id : "",
        what_to_look_for: typeof pp.what_to_look_for === "string" ? pp.what_to_look_for : "",
        offsets: Array.isArray(pp.offsets) && pp.offsets.length === 2
          ? [Number(pp.offsets[0]), Number(pp.offsets[1])] as [number, number]
          : null,
      };
    }),
    agent_correctness: o.agent_correctness as JudgeSpanAnalysis["agent_correctness"],
    classification_hint: o.classification_hint as JudgeSpanAnalysis["classification_hint"],
    judge_confidence: o.judge_confidence as JudgeSpanAnalysis["judge_confidence"],
  };
}

export async function judgeSpan(input: JudgeSpanInput): Promise<JudgeSpanOutput> {
  const start = Date.now();
  const cwd = patientDir(input.patientId);
  const guidelinePath = phenotypeSkillDir(input.taskId);

  // The deepagents provider always requires a chart_review_state MCP config
  // (it spawns the stdio server to serve the chart). The NER judge is
  // read-only — it reads the note + ontology via the MCP tools and never
  // commits — so point it at a throwaway scratch reviewsRoot (any set_*
  // write the judge might make is discarded). Without this, the provider
  // rejects the run. Mirrors judgeCell's block, keyed by span_id.
  const task = loadCompiledTask(input.taskId);
  const judgeScratch = path.join(
    PLATFORM_ROOT, "var", "_judge_scratch", `${input.patientId}-${input.span_id}`,
  );
  const mcpServers = task
    ? buildMcpServersConfig(
        input.patientId, task, `judge-${input.patientId}-${input.span_id}`,
        { onStateUpdate: () => {} },
        { reviewsRoot: judgeScratch, provider: input.provider },
      )
    : undefined;

  let resultText = "";
  let cost: number | undefined;

  try {
    for await (const event of runAgent({
      prompt: buildSpanJudgePrompt(input),
      cwd,
      patientId: input.patientId,
      taskId: input.taskId,
      guidelinePath,
      mcpServers,
      phi: isPhiPatient(input.patientId),
      maxTurns: 24,
      model: judgeModel(),
      provider: input.provider,
      extraSystemPrompt:
        "You are the chart-review-ner-judge skill. Produce ONE strict-JSON " +
        "record wrapped in <JUDGE_ANALYSIS> sentinels. Do not commit, " +
        "do not edit, do not narrate.",
    })) {
      if (event.type === "result") {
        if (event.result) resultText = event.result;
        if (typeof event.cost_usd === "number") cost = event.cost_usd;
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: `judge agent failed: ${(e as Error).message}`,
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: judgeModel(),
    };
  }

  const sentinel = extractSentinel(resultText, "JUDGE_ANALYSIS");
  if (!sentinel) {
    return {
      ok: false,
      error: "judge response missing <JUDGE_ANALYSIS> sentinel",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: judgeModel(),
    };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(sentinel); } catch (e) {
    return {
      ok: false,
      error: `judge JSON parse failed: ${(e as Error).message}`,
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: judgeModel(),
    };
  }
  const analysis = validateSpanAnalysis(parsed);
  if (!analysis) {
    return {
      ok: false,
      error: "judge response failed NER schema validation",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: judgeModel(),
    };
  }
  return {
    ok: true, analysis,
    cost_usd: cost,
    duration_ms: Date.now() - start,
    model: judgeModel(),
  };
}
