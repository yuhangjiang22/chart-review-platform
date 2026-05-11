// @chart-review/agent-core — provider-neutral agent types.
//
// This package is the dependency floor of the agent stack. It holds
// only types + small validation helpers; no SDK, no runtime.
//
// Concrete providers (@chart-review/agent-provider-claude,
// @chart-review/agent-provider-codex, …) implement AgentProvider against
// this contract. Callers depend on AgentProvider (the interface) and
// never on a specific implementation.

/** A single event emitted by an agent during a run. Providers translate
 *  their underlying SDK / CLI events into this shape. */
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
 *  alongside their package + buildProvider switch case. */
export type ProviderName = "claude" | "codex";
export const PROVIDER_NAMES: ProviderName[] = ["claude", "codex"];

export function isProviderName(s: unknown): s is ProviderName {
  return s === "claude" || s === "codex";
}

/** Minimal input to run an agent. Providers extend this shape with
 *  their own option fields via the broader ComposeAgentInput type
 *  defined alongside the runtime composer in @chart-review/agent-runtime
 *  (TBD). For now we keep the minimum here. */
export interface AgentRunInputBase {
  /** Per-call provider override. Falls back to AGENT_PROVIDER env var
   *  when undefined. */
  provider?: ProviderName;
  /** The user prompt sent to the model. */
  prompt: string;
  /** Working directory for tool calls (e.g. file reads). */
  cwd: string;
  /** Optional model id. Provider-specific. */
  model?: string;
}

/** Provider contract: one method that yields events. Implementations
 *  are responsible for translating their underlying SDK / CLI output
 *  into AgentEvents. The returned iterable is single-shot. */
export interface AgentProvider<I extends AgentRunInputBase = AgentRunInputBase> {
  run(input: I): AsyncIterable<AgentEvent>;
}
