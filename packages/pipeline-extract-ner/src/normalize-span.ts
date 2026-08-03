/**
 * Per-span ontology mapping via a small, focused LLM call.
 *
 * The first-pass extractor identifies (text, anchor, entity_type) but
 * doesn't know what concepts exist in the ontology — so it tends to
 * invent plausible-sounding concept_names ("Long-term smoker") that
 * the validation gate then auto-downgrades to novel_candidate.
 *
 * This helper runs a SECOND pass per span: given the verbatim entity
 * text, ~200 chars of surrounding context, and the actual list of
 * concept (id, label) pairs for that entity_type, ask the model to
 * pick one or declare novel. The concept list is small per type
 * (typically 10-200 entries), independent of note content, and
 * stable across all spans of that type — prompt cache covers the
 * prefix so the per-span call is cheap.
 *
 * Returns `{ concept_name, status, reasoning }`. `status='mapped'`
 * iff the chosen concept_name is in the provided list (server-side
 * verification — we don't trust the model to follow instructions).
 */

import { callLlm, type LlmMode } from "./llm-call.js";

interface ConceptEntry { id: string; label: string }

export interface NormalizeSpanOpts {
  /** Verbatim span text (the entity itself). */
  text: string;
  /** Wider context around the span (e.g. ±150 chars). Helps the model
   *  disambiguate ambiguous mentions. */
  context: string;
  /** Entity-type root chosen by the first pass. */
  entityType: string;
  /** All concepts available under this entity_type (id + label only). */
  concepts: ConceptEntry[];
  /** LLM provider switch — same shape as the first-pass extractor.
   *  `"claude"` routes through the Claude Agent SDK; anything else
   *  (default `"codex"`) routes through `callLlm` with the chosen
   *  transport `mode`. */
  provider?: "codex" | "claude";
  /** Endpoint config for the `callLlm` transport (used when
   *  provider !== "claude"). */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Transport selector for `callLlm`. Defaults to `"openrouter"`. */
  mode?: LlmMode;
  /** Role-framing prose prepended to the system prompt (same content
   *  passed to Pass 1). Lets default vs skeptical agents reach
   *  different mapping decisions when the entity is ambiguous. */
  rolePrompt?: string;
}

export interface NormalizeSpanResult {
  concept_name: string;
  status: "mapped" | "novel_candidate";
  reasoning?: string;
  /** Token usage of THIS mapping call (separate from the first pass). */
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: string;
}

function buildSystemPrompt(concepts: ConceptEntry[], entityType: string, rolePrompt = ""): string {
  const lines: string[] = [];
  if (rolePrompt) {
    lines.push("--- Reviewer role framing ---", rolePrompt, "--- End role framing ---", "");
  }
  lines.push(
    "You are mapping a clinical entity to a canonical ontology concept.",
    `Entity type: ${entityType}`,
    "",
    "Allowed concepts (id : label). You MUST pick one of these or declare 'novel':",
    ...concepts.map((c) => `  - ${c.id} : ${c.label}`),
    "",
    "Decision rules:",
    "- If the entity is an exact name OR an unambiguous synonym OR a specific instance of one concept in the list → return status=\"mapped\" and concept_name = THAT concept's id verbatim.",
    "- If the entity describes a property/value (e.g. 'age 67') and the list only has the parent category (e.g. 'Age'), still map to the parent.",
    "- If multiple concepts fit, pick the most specific.",
    "- If no concept in the list reasonably covers the entity → status=\"novel_candidate\", concept_name=\"\".",
    "",
    "OUTPUT (single JSON object, no markdown, no commentary):",
    '  { "concept_name": "<id from the list or empty>", "status": "mapped" | "novel_candidate", "reasoning": "<one short sentence>" }',
  );
  return lines.join("\n");
}

function buildUserPrompt(text: string, context: string): string {
  return [
    `Entity text: ${JSON.stringify(text)}`,
    "",
    "Surrounding context (verbatim from the note, the entity occurs inside this):",
    "```",
    context,
    "```",
    "",
    "Return the JSON object now.",
  ].join("\n");
}

function parse(text: string): { concept_name: string; status: "mapped" | "novel_candidate"; reasoning?: string } | null {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1]!.trim();
  const start = s.indexOf("{");
  if (start > 0) s = s.slice(start);
  try {
    const parsed = JSON.parse(s) as { concept_name?: string; status?: string; reasoning?: string };
    const status = parsed.status === "mapped" ? "mapped" : "novel_candidate";
    return {
      concept_name: typeof parsed.concept_name === "string" ? parsed.concept_name : "",
      status,
      reasoning: parsed.reasoning,
    };
  } catch { return null; }
}

interface ProviderCallResult {
  text: string;
  usage?: NormalizeSpanResult["usage"];
  error?: string;
}

/** Transport-pluggable call (OpenRouter chat-completions by default;
 *  Azure Responses behind `mode: "azure-responses"`). Mirrors the
 *  first-pass extractor's `callLlm` usage — only the max-token budget
 *  differs (the mapping reply is a small JSON object). */
async function callViaTransport(opts: NormalizeSpanOpts, system: string, user: string): Promise<ProviderCallResult> {
  try {
    const res = await callLlm(
      {
        baseUrl: opts.baseUrl ?? "",
        apiKey: opts.apiKey ?? "",
        model: opts.model ?? "gpt-5.2",
        mode: opts.mode ?? "openrouter",
      },
      system,
      user,
      256,
    );
    return { text: res.text, usage: res.usage };
  } catch (e) { return { text: "", error: (e as Error).message }; }
}

async function callClaude(opts: NormalizeSpanOpts, system: string, user: string): Promise<ProviderCallResult> {
  let queryFn: typeof import("@anthropic-ai/claude-agent-sdk")["query"];
  try {
    ({ query: queryFn } = await import("@anthropic-ai/claude-agent-sdk"));
  } catch (e) {
    return { text: "", error: `claude-agent-sdk import failed: ${(e as Error).message}` };
  }
  let text = "", finalResult = "";
  let usage: NormalizeSpanResult["usage"] | undefined;
  try {
    for await (const msg of queryFn({
      prompt: user,
      options: {
        systemPrompt: system, permissionMode: "bypassPermissions",
        mcpServers: {}, allowedTools: [], settingSources: [],
      },
    } as Parameters<typeof queryFn>[0]) as AsyncIterable<Record<string, unknown>>) {
      const t = msg.type;
      if (t === "assistant") {
        const message = msg.message as { content?: unknown[] } | undefined;
        for (const block of message?.content ?? []) {
          const b = block as { type?: string; text?: string };
          if (b.type === "text" && typeof b.text === "string") text += b.text;
        }
      } else if (t === "result") {
        if (typeof msg.result === "string") finalResult = msg.result;
        const u = msg.usage as { input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } | undefined;
        if (u) usage = { input_tokens: u.input_tokens, cached_input_tokens: u.cache_read_input_tokens, output_tokens: u.output_tokens };
      }
    }
  } catch (e) { return { text: "", error: (e as Error).message }; }
  return { text: text || finalResult, usage };
}

export async function normalizeSpanWithLLM(opts: NormalizeSpanOpts): Promise<NormalizeSpanResult> {
  if (!opts.concepts || opts.concepts.length === 0) {
    return { concept_name: "", status: "novel_candidate" };
  }
  const system = buildSystemPrompt(opts.concepts, opts.entityType, opts.rolePrompt);
  const user = buildUserPrompt(opts.text, opts.context);
  const res = (opts.provider ?? "codex") === "claude"
    ? await callClaude(opts, system, user)
    : await callViaTransport(opts, system, user);
  if (res.error) {
    return { concept_name: "", status: "novel_candidate", error: res.error, usage: res.usage };
  }
  const parsed = parse(res.text);
  if (!parsed) {
    return { concept_name: "", status: "novel_candidate", error: "non-JSON response", usage: res.usage };
  }
  // Server-side trust check: the model claimed status=mapped — verify
  // the concept is in the allowed list. If not, demote to novel.
  // Also canonicalize the returned concept_name to the human LABEL
  // (e.g. "Smoking") instead of whatever the model emitted (id like
  // "00065" or a case-variant label) so the SpanReview UI shows
  // readable names.
  if (parsed.status === "mapped" && parsed.concept_name) {
    const target = parsed.concept_name.toLowerCase().replace(/[ _-]+/g, "_");
    const hit = opts.concepts.find((c) => {
      const id = c.id.toLowerCase().replace(/[ _-]+/g, "_");
      const lbl = (c.label ?? "").toLowerCase().replace(/[ _-]+/g, "_");
      return id === target || lbl === target;
    });
    if (!hit) {
      return {
        concept_name: "", status: "novel_candidate",
        reasoning: `model picked '${parsed.concept_name}' which is not in the list — demoted`,
        usage: res.usage,
      };
    }
    return {
      concept_name: hit.label || hit.id,
      status: "mapped",
      reasoning: parsed.reasoning,
      usage: res.usage,
    };
  }
  return { ...parsed, usage: res.usage };
}

/** Helper — extract a context window around a span. */
export function spanContext(noteContent: string, start: number, end: number, radius = 150): string {
  const a = Math.max(0, start - radius);
  const b = Math.min(noteContent.length, end + radius);
  let prefix = noteContent.slice(a, start);
  let suffix = noteContent.slice(end, b);
  // Trim to nearest newline outward so we don't bisect mid-sentence too aggressively.
  const nl = prefix.lastIndexOf("\n");
  if (nl > 0) prefix = prefix.slice(nl + 1);
  const nl2 = suffix.indexOf("\n");
  if (nl2 > 0) suffix = suffix.slice(0, nl2);
  return prefix + noteContent.slice(start, end) + suffix;
}
