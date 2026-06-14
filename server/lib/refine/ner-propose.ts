// refine/ner-propose.ts — NER refiner (S2). Turns one entity type's span-error
// cluster into a transparent ②③ proposal: what the guidance fails to say, and a
// generalizable clarification to append to the entity-type guidance. Mirrors
// propose.ts (runAgent + refiner model + <REFINE_PROPOSAL> sentinel + leakage
// scan), but the unit is an entity_type and the edit target is the YAML
// `guidance` prose.

import path from "node:path";
import { runAgent, type ProviderName } from "../agent-provider.js";
import { modelFor } from "@chart-review/model-config";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";
import { loadCompiledTask } from "@chart-review/tasks";
import { buildMcpServersConfig } from "@chart-review/mcp-server-anthropic";
import type { NerRefinementExample } from "./ner-candidates.js";

export interface ProposeNerEditInput {
  taskId: string;
  entityType: string;
  guidanceText: string;
  examples: NerRefinementExample[];
  provider?: ProviderName;
}

export interface NerEditProposal {
  gap_summary: string;
  /** The generalizable clarification to append to the entity-type guidance. */
  proposed_guidance_addition: string;
  rationale: string;
  leakage_warning?: string;
}

export interface ProposeNerEditOutput {
  ok: boolean;
  proposal?: NerEditProposal;
  error?: string;
  cost_usd?: number;
  duration_ms: number;
  model?: string;
}

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

function validate(parsed: unknown): NerEditProposal | null {
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

/** Light anti-memorization scan: a guidance addition should describe a PATTERN,
 *  not echo a single span verbatim. Flags when the text contains a ≥40-char
 *  verbatim slice of one example's span text. (No patient ids in NER examples.) */
export function scanNerLeakage(addition: string, examples: NerRefinementExample[]): string | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const a = norm(addition);
  const MIN = 40;
  for (const ex of examples) {
    for (const t of [ex.agent_text, ex.human_text]) {
      if (typeof t !== "string") continue;
      const g = norm(t);
      if (g.length < MIN) continue;
      for (let i = 0; i + MIN <= a.length; i++) {
        if (g.includes(a.slice(i, i + MIN))) {
          return `proposed addition copies a ${MIN}+ char verbatim slice of a span ("…${a.slice(i, i + MIN)}…") — state the general pattern, not the specific text.`;
        }
      }
    }
  }
  return null;
}

function exLine(ex: NerRefinementExample): string {
  switch (ex.kind) {
    case "over_extraction":
      return `- OVER-EXTRACTION: agent labeled "${ex.agent_text}" (${ex.agent_concept || "novel"}); reviewer rejected it.`;
    case "under_extraction":
      return `- MISSED: reviewer kept "${ex.human_text}" (${ex.human_concept || "novel"}); agent omitted it.`;
    case "concept_mismatch":
      return `- CONCEPT: "${ex.human_text ?? ex.agent_text}" agent→${ex.agent_concept || "novel"}, reviewer→${ex.human_concept || "novel"}.`;
    case "type_mismatch":
      return `- TYPE: "${ex.human_text ?? ex.agent_text}" agent→${ex.agent_entity_type}, reviewer→${ex.human_entity_type}.`;
    case "boundary":
      return `- BOUNDARY: agent "${ex.agent_text}" vs reviewer "${ex.human_text}".`;
  }
}

export function buildNerRefinerPrompt(input: ProposeNerEditInput): string {
  return [
    "You are the chart-review NER guidance REFINER. An entity type's span errors",
    "(agent vs the human reviewer's validated spans) were attributed to a GUIDANCE",
    "GAP or genuine ambiguity. Propose ONE generalizable clarification to append to",
    "the entity-type guidance so future annotators (human or agent) handle this",
    "class of span consistently.",
    "",
    "Everything is INLINE — do NOT read files. Emit ONE JSON record wrapped in",
    "<REFINE_PROPOSAL>...</REFINE_PROPOSAL>. Read-only.",
    "",
    `## Entity type: ${input.entityType}  (task ${input.taskId})`,
    "### Current guidance",
    input.guidanceText.trim() || "(empty)",
    "",
    `## The ${input.examples.length} span error(s)`,
    ...input.examples.slice(0, 30).map(exLine),
    "",
    "## How to write the addition",
    "- GENERALIZE the pattern: a rule any annotator can apply to NEW notes (e.g.",
    "  'Do NOT tag household-size phrases such as \"family of N\" — that is not a",
    "  demographic concept.'). State the linguistic/clinical feature, NOT a specific",
    "  span. Do NOT copy a span verbatim. 1-3 sentences in the guidance's voice.",
    "",
    "OUTPUT SCHEMA — exact field names:",
    "<REFINE_PROPOSAL>",
    "{",
    '  "gap_summary": "<1-2 sentences: what the guidance fails to specify>",',
    '  "proposed_guidance_addition": "<the generalizable clarification to append — a rule, NOT a verbatim span>",',
    '  "rationale": "<why this fixes the error class>"',
    "}",
    "</REFINE_PROPOSAL>",
  ].join("\n");
}

export async function proposeNerGuidanceEdit(input: ProposeNerEditInput): Promise<ProposeNerEditOutput> {
  const start = Date.now();
  if (!input.examples.length) {
    return { ok: false, error: "no examples provided to the refiner", duration_ms: Date.now() - start };
  }
  const pid = input.examples[0].patient_id;
  const cwd = patientDir(pid);
  const task = loadCompiledTask(input.taskId);
  const scratch = path.join(PLATFORM_ROOT, "var", "_refine_scratch", `ner-${input.taskId}-${input.entityType}`);
  const mcpServers = task
    ? buildMcpServersConfig(
        pid, task, `ner-refine-${input.taskId}-${input.entityType}`,
        { onStateUpdate: () => {} },
        { reviewsRoot: scratch, provider: input.provider },
      )
    : undefined;

  let resultText = "";
  let cost: number | undefined;
  try {
    for await (const event of runAgent({
      prompt: buildNerRefinerPrompt(input),
      cwd,
      patientId: pid,
      taskId: input.taskId,
      guidelinePath: guidelineDir(input.taskId),
      mcpServers,
      phi: isPhiPatient(pid),
      maxTurns: 12,
      model: refinerModel(),
      provider: input.provider,
      extraSystemPrompt:
        "You are the chart-review NER guidance refiner. Produce ONE strict-JSON " +
        "record wrapped in <REFINE_PROPOSAL> sentinels. Reason only from the inline " +
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
    return { ok: false, error: (e as Error).message, duration_ms: Date.now() - start, model: refinerModel() };
  }

  const wrapped = extractSentinel(resultText, "REFINE_PROPOSAL");
  if (!wrapped) {
    return { ok: false, error: "refiner response missing <REFINE_PROPOSAL> sentinel", duration_ms: Date.now() - start, cost_usd: cost, model: refinerModel() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped);
  } catch (e) {
    return { ok: false, error: `refiner response was not valid JSON: ${(e as Error).message}`, duration_ms: Date.now() - start, cost_usd: cost, model: refinerModel() };
  }
  const proposal = validate(parsed);
  if (!proposal) {
    return { ok: false, error: "refiner response failed schema validation", duration_ms: Date.now() - start, cost_usd: cost, model: refinerModel() };
  }
  const leak = scanNerLeakage(proposal.proposed_guidance_addition, input.examples);
  if (leak) proposal.leakage_warning = leak;
  return { ok: true, proposal, cost_usd: cost, duration_ms: Date.now() - start, model: refinerModel() };
}
