// agent-provider.ts — provider-agnostic interface for running an agent.
//
// Today: only ClaudeAgentProvider exists, wrapping the @anthropic-ai/
// claude-agent-sdk's `query()`. Future: a CodexAgentProvider can be
// added by translating `codex exec --json` JSONL events into the same
// AgentEvent taxonomy.
//
// Call sites import { agentProvider } from this module and never
// reference the SDK directly. The provider is selected at module load
// based on the AGENT_PROVIDER env var (defaults to "claude").

import type { ComposeAgentInput } from "./compose-agent.js";

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
export type ProviderName = "claude" | "codex";
export const PROVIDER_NAMES: ProviderName[] = ["claude", "codex"];

export function isProviderName(s: unknown): s is ProviderName {
  return s === "claude" || s === "codex";
}

/** Input shape for a single agent run. Re-uses ComposeAgentInput so
 *  call sites can construct the same options they always have, plus
 *  the user prompt. `provider` is an optional per-call override of the
 *  AGENT_PROVIDER env var — when set, runAgent builds a fresh provider
 *  for this call instead of using the cached default. */
export type AgentRunInput = ComposeAgentInput & {
  prompt: string;
  provider?: ProviderName;
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
    case "claude": {
      const { ClaudeAgentProvider } = await import("./agent-provider-claude.js");
      return new ClaudeAgentProvider();
    }
    case "codex": {
      const { CodexAgentProvider } = await import("./agent-provider-codex.js");
      return new CodexAgentProvider();
    }
  }
}

/** Module-level singleton for the env-var default. Lazy import keeps
 *  the Claude SDK out of memory in a Codex-only deployment (and vice
 *  versa). Per-run overrides bypass this cache. */
let cached: AgentProvider | null = null;

export function defaultProviderName(): ProviderName {
  const raw = (process.env.AGENT_PROVIDER ?? "claude").toLowerCase();
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

/** Convenience: run an agent and yield events directly. Most callers
 *  should use this — they don't need the provider object, only its
 *  output stream. */
export async function* runAgent(input: AgentRunInput): AsyncIterable<AgentEvent> {
  const provider = input.provider
    ? await buildProvider(input.provider)
    : await getAgentProvider();
  yield* provider.run(input);
}
