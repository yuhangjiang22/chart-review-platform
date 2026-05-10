// override-suggester.ts — one-shot chart-review-copilot Mode 4 (Document) call.
//
// When the reviewer is about to override a field, the OverrideForm calls
// `/api/reviews/:patientId/:taskId/suggest-override-reason` with the proposed
// new answer. We fire a single-turn agent query against the review-copilot
// skill, cwd'd into the patient folder, and return the suggested override
// reason text. The reviewer pastes/edits before submitting — we do NOT
// commit anything here.
//
// The chat-side path (long-lived AgentSession) is for free-form Q&A; this
// module is for a structured one-shot suggestion the form can render inline.

import path from "path";
import { runAgent } from "./agent-provider.js";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "./patients.js";
import { guidelineDir } from "./domain/rubric/index.js";

export interface SuggestOverrideInput {
  patientId: string;
  taskId: string;
  fieldId: string;
  oldAnswer: unknown;
  newAnswer: unknown;
}

export interface SuggestOverrideOutput {
  ok: boolean;
  suggestion: string;
  cost_usd?: number;
  duration_ms: number;
}

const PROMPT_PREAMBLE = [
  "Activate the `chart-review-copilot` skill via the Skill tool and operate in",
  "Mode 4 (Document). Read the chart and the criterion, then write a single",
  "override-reason paragraph the reviewer can paste into the override form.",
  "",
  "The paragraph must:",
  "  (a) cite the specific evidence the reviewer is relying on (note + date),",
  "  (b) name what the agent missed or weighted differently,",
  "  (c) point at the guideline rule that prefers the reviewer's reading,",
  "  (d) stay under 4 sentences.",
  "",
  "If the chart does NOT support the reviewer's new answer, write a single",
  "paragraph saying so plainly + citing the contradicting evidence. Do not",
  "refuse and do not ask follow-up questions.",
  "",
  "OUTPUT FORMAT — strict. Your final assistant message MUST contain the",
  "paragraph wrapped in these exact sentinels and nothing else after the",
  "closing sentinel:",
  "",
  "<OVERRIDE_REASON>",
  "<one paragraph here, plain text, no markdown, no leading 'Based on…' or",
  "'Here is…' boilerplate>",
  "</OVERRIDE_REASON>",
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

/** One progress event from the streaming suggester. The HTTP layer
 *  writes these as SSE frames; the client renders tool pills as they land. */
export type SuggestOverrideEvent =
  | { type: "tool_use"; toolName: string; toolInput: unknown }
  | { type: "narration"; text: string }
  | {
      type: "result";
      ok: boolean;
      suggestion: string;
      cost_usd?: number;
      duration_ms: number;
    }
  | { type: "error"; error: string };

export async function* suggestOverrideReasonStream(
  input: SuggestOverrideInput,
): AsyncGenerator<SuggestOverrideEvent> {
  const start = Date.now();
  const cwd = patientDir(input.patientId);
  const guidelinePath = guidelineDir(input.taskId);
  const reviewStateAbs = path.join(
    PLATFORM_ROOT,
    "reviews",
    input.patientId,
    input.taskId,
    "review_state.json",
  );

  const userPrompt = [
    PROMPT_PREAMBLE,
    "",
    "## Override context",
    `- patient: ${input.patientId}`,
    `- task: ${input.taskId}`,
    `- field: ${input.fieldId}`,
    `- agent's draft answer: ${JSON.stringify(input.oldAnswer)}`,
    `- reviewer's new answer: ${JSON.stringify(input.newAnswer)}`,
    "",
    "## Read these to ground the paragraph",
    `- review_state: ${reviewStateAbs} (find the field_assessment for ${input.fieldId} — its evidence/rationale/original_agent_snapshot)`,
    `- guideline criterion: ${guidelinePath}/criteria/${input.fieldId}.yaml`,
    `- relevant patient notes under: ${cwd}/notes/`,
  ].join("\n");

  let resultText = "";
  let cost: number | undefined;

  try {
    for await (const event of runAgent({
      prompt: userPrompt,
      cwd,
      patientId: input.patientId,
      taskId: input.taskId,
      guidelinePath,
      phi: isPhiPatient(input.patientId), // #46
      maxTurns: 24,
      extraSystemPrompt:
        "You are the chart-review-copilot operating in Mode 4 (Document). Output a " +
        "single override-reason paragraph as plain text. No preamble, no " +
        "markdown formatting, no surrounding quotes.",
    })) {
      if (event.type === "tool_use") {
        yield {
          type: "tool_use",
          toolName: event.tool_name,
          toolInput: event.tool_input,
        };
      } else if (event.type === "text") {
        if (event.text.trim().length > 0) {
          yield { type: "narration", text: event.text };
        }
      } else if (event.type === "result") {
        if (event.result) resultText = event.result;
        if (typeof event.cost_usd === "number") cost = event.cost_usd;
        console.log(
          `[override-suggester] ${input.patientId}/${input.fieldId}: subtype=${event.subtype} cost=${cost} resultLen=${event.result?.length ?? 0}`,
        );
      } else if (event.type === "error") {
        yield { type: "error", error: event.error };
        return;
      }
    }
  } catch (e) {
    yield { type: "error", error: (e as Error).message };
    return;
  }

  const wrapped = extractSentinel(resultText, "OVERRIDE_REASON");
  const suggestion = wrapped ?? resultText.trim();
  yield {
    type: "result",
    ok: suggestion.length > 0,
    suggestion,
    cost_usd: cost,
    duration_ms: Date.now() - start,
  };
}

/** Blocking wrapper kept for backwards compatibility / tests. New UI uses
 *  the streaming endpoint. */
export async function suggestOverrideReason(
  input: SuggestOverrideInput,
): Promise<SuggestOverrideOutput> {
  let final: SuggestOverrideOutput = {
    ok: false,
    suggestion: "",
    duration_ms: 0,
  };
  for await (const ev of suggestOverrideReasonStream(input)) {
    if (ev.type === "result") {
      final = {
        ok: ev.ok,
        suggestion: ev.suggestion,
        cost_usd: ev.cost_usd,
        duration_ms: ev.duration_ms,
      };
    } else if (ev.type === "error") {
      throw new Error(ev.error);
    }
  }
  return final;
}
