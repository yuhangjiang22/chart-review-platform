// refine/adherence-propose.ts — adherence refiner (propose). Turns one
// question's attributed answer disagreements into a transparent ②③ proposal: a
// generalizable clarification to add to the question's retrieval_hints so future
// reviewers answer it consistently. Mirrors ner-propose.ts.

import path from "node:path";
import { runAgent, type ProviderName } from "../agent-provider.js";
import { modelFor } from "@chart-review/model-config";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";
import { loadCompiledTask } from "@chart-review/tasks";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import type { AdherenceRefinementExample } from "./adherence-candidates.js";

export interface ProposeAdherenceEditInput {
  taskId: string;
  questionId: string;
  questionText: string;
  retrievalHints: string;
  examples: AdherenceRefinementExample[];
  provider?: ProviderName;
}

export interface AdherenceEditProposal {
  gap_summary: string;
  /** The generalizable clarification to append to the question's retrieval_hints. */
  proposed_guidance_addition: string;
  rationale: string;
  leakage_warning?: string;
}

export interface ProposeAdherenceEditOutput {
  ok: boolean;
  proposal?: AdherenceEditProposal;
  error?: string;
  cost_usd?: number;
  duration_ms: number;
  model?: string;
}

function refinerModel(): string | undefined {
  return modelFor("judge") ?? modelFor("default");
}
function extractSentinel(text: string, tag: string): string | null {
  const i = text.indexOf(`<${tag}>`);
  if (i < 0) return null;
  const j = text.indexOf(`</${tag}>`, i + tag.length + 2);
  if (j < 0) return null;
  return text.slice(i + tag.length + 2, j).trim();
}
function validate(parsed: unknown): AdherenceEditProposal | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.gap_summary !== "string" || !o.gap_summary.trim()) return null;
  if (typeof o.proposed_guidance_addition !== "string" || !o.proposed_guidance_addition.trim()) return null;
  if (typeof o.rationale !== "string" || !o.rationale.trim()) return null;
  return {
    gap_summary: o.gap_summary.trim(),
    proposed_guidance_addition: o.proposed_guidance_addition.trim(),
    rationale: o.rationale.trim(),
  };
}

/** Reject a proposal that names a patient id or copies a ≥40-char verbatim slice
 *  of a cited excerpt — a hint should state HOW to find the answer, not a case. */
export function scanAdherenceLeakage(addition: string, examples: AdherenceRefinementExample[]): string | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const a = norm(addition);
  for (const ex of examples) {
    const pid = (ex.patient_id ?? "").trim();
    if (pid && a.includes(pid.toLowerCase())) {
      return `proposed hint names a specific patient id ("${pid}") — state a general rule, not a case.`;
    }
    if (typeof ex.excerpt === "string" && ex.excerpt.trim().length >= 40) {
      const g = norm(ex.excerpt);
      for (let i = 0; i + 40 <= a.length; i++) {
        if (g.includes(a.slice(i, i + 40))) {
          return `proposed hint copies a 40+ char verbatim slice of a cited excerpt — state the general pattern, not the chart text.`;
        }
      }
    }
  }
  return null;
}

export function buildAdherenceRefinerPrompt(input: ProposeAdherenceEditInput): string {
  return [
    "You are the chart-review adherence QUESTION refiner. A question's answer",
    "disagreements (agent vs the human reviewer's validated answers) were attributed",
    "to a guidance gap or genuine ambiguity. Propose ONE generalizable clarification",
    "to append to the question's retrieval guidance (retrieval_hints) so future",
    "reviewers answer it consistently.",
    "",
    "Everything is INLINE — do NOT read files. Emit ONE JSON record wrapped in",
    "<REFINE_PROPOSAL>...</REFINE_PROPOSAL>. Read-only.",
    "",
    `## Question (task ${input.taskId})`,
    `- question_id: ${input.questionId}`,
    `- text: ${JSON.stringify(input.questionText)}`,
    "### Current retrieval_hints",
    input.retrievalHints.trim() || "(none)",
    "",
    `## The ${input.examples.length} answer disagreement(s)`,
    ...input.examples.slice(0, 30).map(
      (e) =>
        `- patient ${e.patient_id}: agent → ${JSON.stringify(e.agent_answer)}, reviewer (correct) → ${JSON.stringify(e.reviewer_answer)}${e.excerpt ? ` [cited: ${JSON.stringify(e.excerpt.slice(0, 160))}]` : ""}`,
    ),
    "",
    "## How to write the addition",
    "- GENERALIZE: a rule any reviewer can apply to NEW charts (e.g. 'When multiple",
    "  ACT scores are documented, use the MOST RECENT before the index date.' or",
    "  'Read structured medication tables before narrative notes.'). State the",
    "  decision/where-to-look rule, NOT a specific answer or chart text. 1-3 sentences.",
    "",
    "OUTPUT SCHEMA — exact field names:",
    "<REFINE_PROPOSAL>",
    "{",
    '  "gap_summary": "<1-2 sentences: what the question/guidance fails to specify>",',
    '  "proposed_guidance_addition": "<the generalizable clarification to append to retrieval_hints>",',
    '  "rationale": "<why this fixes the error class>"',
    "}",
    "</REFINE_PROPOSAL>",
  ].join("\n");
}

export async function proposeAdherenceGuidanceEdit(
  input: ProposeAdherenceEditInput,
): Promise<ProposeAdherenceEditOutput> {
  const start = Date.now();
  if (!input.examples.length) return { ok: false, error: "no examples provided to the refiner", duration_ms: Date.now() - start };
  const pid = input.examples[0].patient_id;
  const task = loadCompiledTask(input.taskId);
  const scratch = path.join(PLATFORM_ROOT, "var", "_refine_scratch", `adh-${input.taskId}-${input.questionId}`);
  const mcpServers = task
    ? buildMcpServersConfig(
        pid, task, `adh-refine-${input.taskId}-${input.questionId}`,
        { onStateUpdate: () => {} },
        { reviewsRoot: scratch, provider: input.provider },
      )
    : undefined;

  let resultText = "";
  let cost: number | undefined;
  try {
    for await (const event of runAgent({
      prompt: buildAdherenceRefinerPrompt(input),
      cwd: patientDir(pid),
      patientId: pid,
      taskId: input.taskId,
      guidelinePath: guidelineDir(input.taskId),
      mcpServers,
      phi: isPhiPatient(pid),
      maxTurns: 12,
      model: refinerModel(),
      provider: input.provider,
      extraSystemPrompt:
        "You are the chart-review adherence question refiner. Produce ONE strict-JSON " +
        "record wrapped in <REFINE_PROPOSAL> sentinels. Reason only from the inline " +
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
    return { ok: false, error: (e as Error).message, duration_ms: Date.now() - start, model: refinerModel() };
  }

  const wrapped = extractSentinel(resultText, "REFINE_PROPOSAL");
  if (!wrapped) return { ok: false, error: "refiner response missing <REFINE_PROPOSAL> sentinel", duration_ms: Date.now() - start, cost_usd: cost, model: refinerModel() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped);
  } catch (e) {
    return { ok: false, error: `refiner response was not valid JSON: ${(e as Error).message}`, duration_ms: Date.now() - start, cost_usd: cost, model: refinerModel() };
  }
  const proposal = validate(parsed);
  if (!proposal) return { ok: false, error: "refiner response failed schema validation", duration_ms: Date.now() - start, cost_usd: cost, model: refinerModel() };
  const leak = scanAdherenceLeakage(proposal.proposed_guidance_addition, input.examples);
  if (leak) proposal.leakage_warning = leak;
  return { ok: true, proposal, cost_usd: cost, duration_ms: Date.now() - start, model: refinerModel() };
}
