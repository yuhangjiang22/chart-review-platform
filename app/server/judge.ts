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
import { runAgent } from "./agent-provider.js";
import { modelFor } from "./model-config.js";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "./patients.js";
import { phenotypeSkillDir } from "./domain/rubric/index.js";
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
const JUDGE_MODEL = modelFor("judge") ?? modelFor("default");

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

  let resultText = "";
  let cost: number | undefined;

  try {
    for await (const event of runAgent({
      prompt: buildUserPrompt(input),
      cwd,
      patientId: input.patientId,
      taskId: input.taskId,
      guidelinePath,
      phi: isPhiPatient(input.patientId),
      maxTurns: 24,
      model: JUDGE_MODEL,
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
      model: JUDGE_MODEL,
    };
  }

  const wrapped = extractSentinel(resultText, "JUDGE_ANALYSIS");
  if (!wrapped) {
    return {
      ok: false,
      error: "judge response missing <JUDGE_ANALYSIS> sentinel",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: JUDGE_MODEL,
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
      model: JUDGE_MODEL,
    };
  }
  const analysis = validateAnalysis(parsed);
  if (!analysis) {
    return {
      ok: false,
      error: "judge response failed schema validation",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: JUDGE_MODEL,
    };
  }
  return {
    ok: true,
    analysis,
    cost_usd: cost,
    duration_ms: Date.now() - start,
    model: JUDGE_MODEL,
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
