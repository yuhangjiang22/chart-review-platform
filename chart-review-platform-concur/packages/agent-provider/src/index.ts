// agent-provider.ts — provider-agnostic interface for running an agent.
//
// The only provider is DeepAgentsProvider, which spawns a Python
// deepagents sidecar and translates its JSONL stdout into the
// AgentEvent taxonomy below.
//
// Call sites import { agentProvider } from this module and never
// reference the SDK directly. The provider is selected at module load
// based on the AGENT_PROVIDER env var (defaults to "deepagents").

import type { ComposeAgentInput } from "@chart-review/agent-compose";

/** Streamed events from a single agent run, normalized across providers.
 *
 *  Mapping from Anthropic SDK messages:
 *    assistant.message.content[i].type === "tool_use"  → tool_use
 *    assistant.message.content[i].type === "text"      → text
 *    result                                            → result
 *
 *  Mapping from Codex `exec --json` JSONL (future):
 *    item.completed.item.type === "command_execution" → tool_use (start) +
 *                                                       tool_result (complete)
 *    item.completed.item.type === "agent_message"    → text
 *    turn.completed.usage                            → result (with usage)
 *    error                                           → error
 */
export type AgentEvent =
  | {
      type: "tool_use";
      tool_name: string;
      tool_input: unknown;
      tool_use_id?: string;
    }
  | {
      type: "tool_result";
      tool_use_id?: string;
      output: unknown;
    }
  | { type: "text"; text: string }
  | {
      type: "result";
      /** Final assistant text (when the SDK provides one). */
      result?: string;
      /** Cost in USD. Anthropic provides this directly; Codex requires
       *  client-side computation from token counts. May be undefined. */
      cost_usd?: number;
      /** Anthropic-specific success/subtype field. May be undefined for
       *  other providers; consumers that care should treat undefined
       *  as success. */
      subtype?: string;
      /** Provider-specific raw usage block (token counts, etc.). */
      usage?: unknown;
    }
  | { type: "error"; error: string };

/** Provider names recognized by the platform. Add new providers here
 *  alongside their lazy import in `buildProvider`. */
export type ProviderName = "deepagents";
export const PROVIDER_NAMES: ProviderName[] = ["deepagents"];

export function isProviderName(s: unknown): s is ProviderName {
  return s === "deepagents";
}

/** Input shape for a single agent run. Re-uses ComposeAgentInput so
 *  call sites can construct the same options they always have, plus
 *  the user prompt. `provider` is an optional per-call override of the
 *  AGENT_PROVIDER env var — when set, runAgent builds a fresh provider
 *  for this call instead of using the cached default. */
export type AgentRunInput = ComposeAgentInput & {
  prompt: string;
  provider?: ProviderName;
  /** Optional absolute path to a JSONL file. When set, every AgentEvent
   *  produced by the underlying provider is appended (tool_result outputs
   *  truncated at 4 KB) so the run is fully auditable after the fact.
   *  Provider-agnostic — works for both Claude and Codex. Set
   *  CHART_REVIEW_TRANSCRIPTS=0 to disable even when a path is supplied. */
  transcriptPath?: string;
  /** Read/compute tool modules the deepagents sidecar loads as plugins, in
   *  addition to the MCP tools (import paths, e.g. "chart_review_plugins.rucam").
   *  See @chart-review/task-tools ToolProfile.pythonPlugins. */
  pythonPlugins?: string[];
  /** Data dir the plugin tools read (bound into each plugin tool at load). */
  dataDir?: string;
  /** Extra run context force-bound into plugin tools (e.g. person_id for
   *  cohort-CSV tasks like RUCAM). Merged with dataDir on the sidecar. */
  pluginBind?: Record<string, unknown>;
};

/** Provider contract: one method that yields events. Implementations
 *  are responsible for translating their underlying SDK / CLI output
 *  into AgentEvents. The returned iterable is single-shot — iterate it
 *  exactly once. */
export interface AgentProvider {
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}

async function buildProvider(name: ProviderName): Promise<AgentProvider> {
  switch (name) {
    case "deepagents": {
      const { DeepAgentsProvider } = await import("@chart-review/agent-provider-deepagents");
      return new DeepAgentsProvider();
    }
  }
}

/** Module-level singleton for the env-var default. Lazy import keeps
 *  the Claude SDK out of memory in a Codex-only deployment (and vice
 *  versa). Per-run overrides bypass this cache. */
let cached: AgentProvider | null = null;

export function defaultProviderName(): ProviderName {
  const raw = (process.env.AGENT_PROVIDER ?? "deepagents").toLowerCase();
  if (!isProviderName(raw)) {
    throw new Error(
      `Unknown AGENT_PROVIDER=${raw}. Supported: ${PROVIDER_NAMES.join(", ")}.`,
    );
  }
  return raw;
}

export async function getAgentProvider(): Promise<AgentProvider> {
  if (cached) return cached;
  cached = await buildProvider(defaultProviderName());
  return cached;
}

/** Cap on per-tool_result payload size persisted to the transcript.
 *  Read tool calls against large files can blow up the JSONL otherwise. */
const TRANSCRIPT_MAX_RESULT_BYTES = 4096;

function truncateForTranscript(o: unknown): unknown {
  if (typeof o === "string") {
    if (o.length <= TRANSCRIPT_MAX_RESULT_BYTES) return o;
    return o.slice(0, TRANSCRIPT_MAX_RESULT_BYTES)
      + `… [truncated, ${o.length - TRANSCRIPT_MAX_RESULT_BYTES} more chars]`;
  }
  try {
    const s = JSON.stringify(o);
    if (s.length <= TRANSCRIPT_MAX_RESULT_BYTES) return o;
    return s.slice(0, TRANSCRIPT_MAX_RESULT_BYTES)
      + `… [truncated, ${s.length - TRANSCRIPT_MAX_RESULT_BYTES} more chars]`;
  } catch {
    return o;
  }
}

function sanitizeForTranscript(e: AgentEvent): AgentEvent {
  if (e.type === "tool_result") {
    return { ...e, output: truncateForTranscript(e.output) };
  }
  return e;
}

async function appendTranscript(fp: string, event: AgentEvent): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(fp), { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...sanitizeForTranscript(event),
  }) + "\n";
  await fs.appendFile(fp, line);
}

/** Convenience: run an agent and yield events directly. Most callers
 *  should use this — they don't need the provider object, only its
 *  output stream. When `transcriptPath` is set and
 *  CHART_REVIEW_TRANSCRIPTS!=0, every event is appended to that file
 *  as JSONL before being yielded downstream. */
export async function* runAgent(input: AgentRunInput): AsyncIterable<AgentEvent> {
  const provider = input.provider
    ? await buildProvider(input.provider)
    : await getAgentProvider();
  const transcriptEnabled =
    input.transcriptPath && process.env.CHART_REVIEW_TRANSCRIPTS !== "0";
  for await (const event of provider.run(input)) {
    if (transcriptEnabled) {
      try { await appendTranscript(input.transcriptPath!, event); }
      catch { /* transcript persistence is best-effort; never fail the run */ }
    }
    yield event;
  }
}
