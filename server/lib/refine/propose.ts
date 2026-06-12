// refine/propose.ts — Task S2 of the self-refinement increment.
//
// The REFINER: turn one criterion's cluster of attributed agent-vs-human
// disagreements (the ① data from candidates.ts) into the ② (why) + ③ (rule to
// add) of a transparent proposal card. One LLM call, modeled on the judge's
// plumbing (server/lib/judge.ts): runAgent + judgeModel() + the scratch-MCP
// pattern + sentinel extraction + strict-schema validation.
//
// What this is NOT (yet): no held-out validation (the ④ Δκ) — that's S3. The
// refiner only proposes; it never measures whether the rule generalizes on
// unseen patients.
//
// Prompt discipline (the careful part): the model is instructed to write a
// GENERALIZABLE decision rule any reviewer could apply — explicitly NOT
// "for patient X answer Y", not patient-id lookups, not gold-value memorization.
// After generation a LEAKAGE SCAN re-reads proposed_rule_text and flags it if it
// smells like instance memorization (a patient_id, or a long verbatim slice of a
// reviewer answer / note excerpt). The flag rides on the result for the card.

import path from "node:path";
import { runAgent, type ProviderName } from "../agent-provider.js";
import { modelFor } from "@chart-review/model-config";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "@chart-review/patients";
import { phenotypeSkillDir } from "@chart-review/rubric";
import { loadCompiledTask } from "@chart-review/tasks";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import type { RefinementExample } from "./candidates.js";

// ── Public shapes ────────────────────────────────────────────────────────────

export interface ProposeRubricEditInput {
  taskId: string;
  fieldId: string;
  /** The criterion's current definition (prompt + definition + extraction
   *  guidance), as assembled by candidates.ts `criterion_def`. */
  criterionDef: string;
  /** The cluster's wrong examples — ALREADY filtered to the refinable subset
   *  (guideline_gap + true_ambiguity) by the caller. The refiner sees ONLY
   *  these. */
  examples: RefinementExample[];
  /** Provider the cluster's run used (so the refiner inherits the same backend
   *  the judge would). Falls back to the AGENT_PROVIDER default when absent. */
  provider?: ProviderName;
}

/** The ②③ + rationale the refiner emits, plus the leakage flag. */
export interface RubricEditProposal {
  /** ② — 1-2 sentences: what the criterion fails to specify that caused these
   *  disagreements. */
  gap_summary: string;
  /** ③ — the EXACT generalizable clarification to append to the criterion. A
   *  decision rule / edge-case handling, never instance memorization. */
  proposed_rule_text: string;
  /** Why this rule fixes the failure class. */
  rationale: string;
  /** Set when the leakage scan suspects instance memorization. Absent = clean.
   *  Surfaced prominently on the card; the human still decides. */
  leakage_warning?: string;
}

export interface ProposeRubricEditOutput {
  ok: boolean;
  proposal?: RubricEditProposal;
  error?: string;
  cost_usd?: number;
  duration_ms: number;
  model?: string;
}

// ── Model + sentinel plumbing (mirrors judge.ts) ───────────────────────────────

/** Resolve the refiner model. Reuses the judge slot — same "more capable
 *  triage" need, and operators already point CHART_REVIEW_JUDGE_MODEL at a
 *  strong model. Resolved at CALL time (dotenv loads after import). */
function refinerModel(): string | undefined {
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

/** Validate the parsed object conforms to RubricEditProposal: the three fields
 *  exist and are non-empty strings. (leakage_warning is added post-scan.) */
function validateProposal(parsed: unknown): RubricEditProposal | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.gap_summary !== "string" || !o.gap_summary.trim()) return null;
  if (typeof o.proposed_rule_text !== "string" || !o.proposed_rule_text.trim()) return null;
  if (typeof o.rationale !== "string" || !o.rationale.trim()) return null;
  return {
    gap_summary: o.gap_summary.trim(),
    proposed_rule_text: o.proposed_rule_text.trim(),
    rationale: o.rationale.trim(),
  };
}

// ── Leakage scan ───────────────────────────────────────────────────────────────

/** Minimum length of a verbatim gold/excerpt slice that counts as
 *  memorization. ~40 chars: long enough that a coincidental phrase match is
 *  unlikely, short enough to catch a copied answer sentence. */
const LEAKAGE_MIN_VERBATIM = 40;

/** Normalize whitespace + lowercase for substring comparison, so a rule that
 *  re-wraps a gold sentence with different spacing still trips the scan. */
function normalizeForScan(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Scan a proposed_rule_text for signs it memorizes the seen examples rather
 * than generalizing the pattern. Returns a human-readable warning string when
 * suspicious, or null when clean. Two checks:
 *
 *   1. PATIENT IDS — the rule names any example's patient_id. A generalizable
 *      rule never references a specific patient.
 *   2. VERBATIM GOLD / EXCERPT — the rule contains a ≥LEAKAGE_MIN_VERBATIM-char
 *      contiguous slice of some example's reviewer_answer or note excerpt. That
 *      looks like the model encoded the gold answer / chart text as a lookup
 *      instead of a rule.
 */
export function scanForLeakage(
  proposedRuleText: string,
  examples: RefinementExample[],
): string | null {
  const ruleNorm = normalizeForScan(proposedRuleText);

  // 1) Patient ids.
  for (const ex of examples) {
    const pid = (ex.patient_id ?? "").trim();
    if (pid && ruleNorm.includes(pid.toLowerCase())) {
      return `proposed rule names a specific patient id ("${pid}") — that is instance memorization, not a generalizable rule.`;
    }
  }

  // 2) Verbatim gold / excerpt slices. Slide a window over the rule and check
  //    whether any LEAKAGE_MIN_VERBATIM-char window is a substring of a
  //    normalized reviewer_answer or excerpt.
  const golds: Array<{ kind: string; text: string }> = [];
  for (const ex of examples) {
    if (ex.reviewer_answer != null) {
      const g = normalizeForScan(String(typeof ex.reviewer_answer === "string"
        ? ex.reviewer_answer
        : JSON.stringify(ex.reviewer_answer)));
      // Only flag reviewer answers that are themselves long enough to be
      // "copied prose" — short enum tokens like "yes"/"metastatic" are
      // legitimately named in a rule.
      if (g.length >= LEAKAGE_MIN_VERBATIM) golds.push({ kind: "reviewer answer", text: g });
    }
    if (typeof ex.excerpt === "string" && ex.excerpt.trim()) {
      const g = normalizeForScan(ex.excerpt);
      if (g.length >= LEAKAGE_MIN_VERBATIM) golds.push({ kind: "note excerpt", text: g });
    }
  }
  for (const g of golds) {
    for (let i = 0; i + LEAKAGE_MIN_VERBATIM <= ruleNorm.length; i++) {
      const window = ruleNorm.slice(i, i + LEAKAGE_MIN_VERBATIM);
      if (g.text.includes(window)) {
        return `proposed rule copies a ${LEAKAGE_MIN_VERBATIM}+ char verbatim slice of a ${g.kind} ("…${window}…") — that looks like memorizing a seen case rather than stating a general rule.`;
      }
    }
  }

  return null;
}

// ── Prompt construction ──────────────────────────────────────────────────────

const PROMPT_PREAMBLE = [
  "You are the chart-review rubric REFINER. A criterion in a clinical",
  "chart-review rubric produced a cluster of disagreements where the drafting",
  "agent's answer differed from the human reviewer's validated answer, and a",
  "judge attributed each to a GUIDELINE GAP or TRUE AMBIGUITY (NOT agent error).",
  "Your job: diagnose what the criterion fails to specify, and propose ONE",
  "generalizable clarification to append to it so future reviewers (human or",
  "agent) handle this class of case consistently.",
  "",
  "Everything you need is INLINE below — do NOT read the patient chart or any",
  "files; reason only from the criterion text and the examples given. Emit ONE",
  "JSON record wrapped in <REFINE_PROPOSAL>...</REFINE_PROPOSAL> sentinels.",
  "Read-only — never commit, edit, or narrate outside the sentinels.",
].join("\n");

function exampleBlock(ex: RefinementExample, i: number): string {
  const excerpt = (ex.excerpt ?? "").slice(0, 600);
  const off =
    Array.isArray(ex.offsets) && ex.offsets.length === 2
      ? ` [${ex.offsets[0]}-${ex.offsets[1]}]`
      : "";
  return [
    `### Example ${i + 1} (patient ${ex.patient_id}, attribution: ${ex.classification_hint})`,
    `- note excerpt${off ? ` (${ex.note_id ?? "?"}${off})` : ""}: ${excerpt ? JSON.stringify(excerpt) : "(no reviewer-cited excerpt)"}`,
    `- agent answered: ${JSON.stringify(ex.agent_answer)}`,
    `- reviewer (correct) answer: ${JSON.stringify(ex.reviewer_answer)}`,
    `- judge reasoning: ${ex.judge_reasoning ? JSON.stringify(ex.judge_reasoning) : "(none)"}`,
  ].join("\n");
}

export function buildRefinerPrompt(input: ProposeRubricEditInput): string {
  const lines = [
    PROMPT_PREAMBLE,
    "",
    "## Criterion under refinement",
    `- task_id: ${input.taskId}`,
    `- field_id: ${input.fieldId}`,
    "",
    "### Current criterion definition (prompt + definition + extraction guidance)",
    input.criterionDef.trim() || "(empty)",
    "",
    `## The ${input.examples.length} disagreement example(s) in this cluster`,
    ...input.examples.map((ex, i) => exampleBlock(ex, i)),
    "",
    "## How to write the rule (read carefully)",
    "- GENERALIZE THE PATTERN across the examples — state a decision criterion or",
    "  edge-case-handling rule that ANY reviewer could apply to NEW patients.",
    "- It MUST be a general rule. Do NOT write \"for patient X, answer Y\". Do NOT",
    "  reference any patient id. Do NOT encode the reviewers' gold answers as a",
    "  lookup or copy chart text verbatim. If the only thing the examples share",
    "  is the gold answer, find the underlying clinical/linguistic feature that",
    "  distinguishes them and state THAT.",
    "- The rule text is appended to the criterion's extraction guidance, so write",
    "  it as a self-contained instruction (1-4 sentences) in the criterion's",
    "  voice (e.g. a new bullet clarifying when a value applies).",
    "",
    "Now emit the strict-JSON proposal. No preamble, no markdown, no commentary",
    "outside the sentinels.",
    "",
    "OUTPUT SCHEMA — use these EXACT field names (the platform validates them; do",
    "NOT rename or omit any field):",
    "<REFINE_PROPOSAL>",
    "{",
    '  "gap_summary": "<1-2 sentences: what the criterion fails to specify that caused these disagreements>",',
    '  "proposed_rule_text": "<the EXACT generalizable clarification to append to the criterion — a decision rule / edge-case handling, NOT instance memorization, NOT patient ids, NOT verbatim gold>",',
    '  "rationale": "<why this rule fixes the failure class across the examples>"',
    "}",
    "</REFINE_PROPOSAL>",
    "All three fields are required and must be non-empty strings.",
  ];
  return lines.join("\n");
}

// ── Entry point ────────────────────────────────────────────────────────────────

/**
 * Run the refiner on one cluster. The caller has already filtered `examples`
 * to the refinable subset (guideline_gap + true_ambiguity). Returns the
 * ②③+rationale proposal with a leakage flag, or an error on schema miss /
 * agent failure (mirrors judgeCell's failure surface).
 */
export async function proposeRubricEdit(
  input: ProposeRubricEditInput,
): Promise<ProposeRubricEditOutput> {
  const start = Date.now();

  if (!input.examples.length) {
    return {
      ok: false,
      error: "no examples provided to the refiner",
      duration_ms: Date.now() - start,
    };
  }

  // The deepagents provider always requires a chart_review_state MCP config
  // (it spawns the stdio server). The refiner is a pure reasoning call — it
  // reads nothing — so we point it at a throwaway scratch reviewsRoot, exactly
  // like judgeCell. A representative patient (the first example's) supplies the
  // cwd/patient context the provider expects; the prompt forbids reading it.
  const representativePid = input.examples[0].patient_id;
  const cwd = patientDir(representativePid);
  const guidelinePath = phenotypeSkillDir(input.taskId);
  const task = loadCompiledTask(input.taskId);
  const scratch = path.join(
    PLATFORM_ROOT, "var", "_refine_scratch", `${input.taskId}-${input.fieldId}`,
  );
  const mcpServers = task
    ? buildMcpServersConfig(
        representativePid, task, `refine-${input.taskId}-${input.fieldId}`,
        { onStateUpdate: () => {} },
        { reviewsRoot: scratch, provider: input.provider },
      )
    : undefined;

  let resultText = "";
  let cost: number | undefined;

  try {
    for await (const event of runAgent({
      prompt: buildRefinerPrompt(input),
      cwd,
      patientId: representativePid,
      taskId: input.taskId,
      guidelinePath,
      mcpServers,
      phi: isPhiPatient(representativePid),
      maxTurns: 12,
      model: refinerModel(),
      provider: input.provider,
      extraSystemPrompt:
        "You are the chart-review rubric refiner. Produce ONE strict-JSON " +
        "record wrapped in <REFINE_PROPOSAL> sentinels. Reason only from the " +
        "inline criterion + examples; do not read files, do not commit, do " +
        "not narrate.",
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
      model: refinerModel(),
    };
  }

  const wrapped = extractSentinel(resultText, "REFINE_PROPOSAL");
  if (!wrapped) {
    return {
      ok: false,
      error: "refiner response missing <REFINE_PROPOSAL> sentinel",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: refinerModel(),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped);
  } catch (e) {
    return {
      ok: false,
      error: `refiner response was not valid JSON: ${(e as Error).message}`,
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: refinerModel(),
    };
  }
  const proposal = validateProposal(parsed);
  if (!proposal) {
    return {
      ok: false,
      error: "refiner response failed schema validation",
      duration_ms: Date.now() - start,
      cost_usd: cost,
      model: refinerModel(),
    };
  }

  // Anti-memorization guard: scan the proposed rule against the examples.
  const leakage = scanForLeakage(proposal.proposed_rule_text, input.examples);
  if (leakage) proposal.leakage_warning = leakage;

  return {
    ok: true,
    proposal,
    cost_usd: cost,
    duration_ms: Date.now() - start,
    model: refinerModel(),
  };
}
