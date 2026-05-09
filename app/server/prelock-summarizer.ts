// prelock-summarizer.ts — one-shot chart-review-copilot pre-lock summary call.
//
// Before the reviewer clicks Lock, the WorkflowBar offers a "Pre-lock
// summary" button that posts to `/api/reviews/:patientId/:taskId/prelock-summary`.
// We fire a single-turn agent query against the chart-review-copilot skill in its
// "Pre-lock summary mode" — the agent reads review_state.json + cited
// evidence and returns a compact checklist of what was approved, what was
// overridden, and anything that would block or weaken the lock.
//
// Read-only on the server side. No state writes.

import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { composeAgentOptions } from "./compose-agent.js";
import { patientDir, PLATFORM_ROOT, isPhiPatient } from "./patients.js";
import { guidelineDir } from "./domain/rubric/index.js";

export interface PreLockSummaryInput {
  patientId: string;
  taskId: string;
}

export interface PreLockSummaryOutput {
  ok: boolean;
  summary: string;
  cost_usd?: number;
  duration_ms: number;
}

const PROMPT = [
  "Activate the `chart-review-copilot` skill via the Skill tool and operate in",
  '"Pre-lock summary mode". Read the current review_state.json for this',
  "patient × task, scan the field assessments, and emit a compact pre-lock",
  "checklist as plain text.",
  "",
  "Section 1 — one line per leaf field, in this exact format:",
  "  - <field_id> = <final answer>  (<status>; <one short note about",
  "    confidence/evidence quality>)",
  "Section 2 — blank line, then `Lock blockers / weak spots:` and bullet",
  "lines for anything that would block or weaken the lock (fields still in",
  "agent_proposed, evidence pins missing fields, low-confidence drafts the",
  "reviewer never touched, internal contradictions). If nothing is blocking,",
  "write a single bullet `- none`.",
  "",
  "Keep it under ~40 lines.",
  "",
  "OUTPUT FORMAT — strict. Your final assistant message MUST contain the",
  "checklist wrapped in these exact sentinels and nothing else after the",
  "closing sentinel. No 'Here is …' or 'Now I will …' preamble.",
  "",
  "<PRELOCK_CHECKLIST>",
  "<plain-text checklist here, no markdown headers>",
  "</PRELOCK_CHECKLIST>",
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

export type PreLockSummaryEvent =
  | { type: "tool_use"; toolName: string; toolInput: unknown }
  | { type: "narration"; text: string }
  | {
      type: "result";
      ok: boolean;
      summary: string;
      cost_usd?: number;
      duration_ms: number;
    }
  | { type: "error"; error: string };

export async function* preLockSummaryStream(
  input: PreLockSummaryInput,
): AsyncGenerator<PreLockSummaryEvent> {
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
    PROMPT,
    "",
    "## Context",
    `- patient: ${input.patientId}`,
    `- task: ${input.taskId}`,
    `- review_state: ${reviewStateAbs}`,
    `- guideline: ${guidelinePath}`,
    `- patient notes under: ${cwd}/notes/`,
  ].join("\n");

  let resultText = "";
  let cost: number | undefined;

  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: composeAgentOptions({
        cwd,
        patientId: input.patientId,
        taskId: input.taskId,
        guidelinePath,
        phi: isPhiPatient(input.patientId), // #46
        maxTurns: 24,
        extraSystemPrompt:
          "You are the chart-review-copilot in pre-lock summary mode. Wrap your " +
          "final checklist in <PRELOCK_CHECKLIST>...</PRELOCK_CHECKLIST>. No " +
          "markdown headers, no preamble before the opening tag.",
      }) as any,
    })) {
      const m = msg as any;
      if (m?.type === "assistant") {
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_use") {
              yield {
                type: "tool_use",
                toolName: String(block.name ?? ""),
                toolInput: block.input,
              };
            } else if (block?.type === "text") {
              const text = String(block.text ?? "");
              if (text.trim().length > 0) {
                yield { type: "narration", text };
              }
            }
          }
        }
      } else if (m?.type === "result") {
        const result = m.result as string | undefined;
        if (result) resultText = result;
        const c = m.total_cost_usd as number | undefined;
        if (typeof c === "number") cost = c;
        console.log(
          `[prelock-summarizer] ${input.patientId}/${input.taskId}: subtype=${m.subtype} cost=${cost} resultLen=${result?.length ?? 0}`,
        );
      }
    }
  } catch (e) {
    yield { type: "error", error: (e as Error).message };
    return;
  }

  const wrapped = extractSentinel(resultText, "PRELOCK_CHECKLIST");
  const summary = wrapped ?? resultText.trim();
  yield {
    type: "result",
    ok: summary.length > 0,
    summary,
    cost_usd: cost,
    duration_ms: Date.now() - start,
  };
}

export async function preLockSummary(
  input: PreLockSummaryInput,
): Promise<PreLockSummaryOutput> {
  let final: PreLockSummaryOutput = {
    ok: false,
    summary: "",
    duration_ms: 0,
  };
  for await (const ev of preLockSummaryStream(input)) {
    if (ev.type === "result") {
      final = {
        ok: ev.ok,
        summary: ev.summary,
        cost_usd: ev.cost_usd,
        duration_ms: ev.duration_ms,
      };
    } else if (ev.type === "error") {
      throw new Error(ev.error);
    }
  }
  return final;
}
