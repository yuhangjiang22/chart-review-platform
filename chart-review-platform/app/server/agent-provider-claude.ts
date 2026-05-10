// agent-provider-claude.ts — AgentProvider impl backed by the
// @anthropic-ai/claude-agent-sdk.
//
// Wraps the SDK's `query({prompt, options})` async iterator and
// translates each emitted message into the AgentEvent taxonomy.
// Call sites should NOT import from this module; they import
// runAgent() / getAgentProvider() from agent-provider.ts.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { composeAgentOptions } from "./compose-agent.js";
import type {
  AgentProvider,
  AgentRunInput,
  AgentEvent,
} from "./agent-provider.js";

export class ClaudeAgentProvider implements AgentProvider {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const { prompt, ...composeInput } = input;
    const options = composeAgentOptions(composeInput);

    try {
      // The SDK's `Options` type doesn't quite match our shape (it's
      // declared narrower than what we actually pass — e.g.
      // settingSources tuple, mcpServers shape). Cast at the boundary;
      // every call site used to do this. See compose-agent.ts for the
      // full ComposeAgentOptions shape.
      for await (const msg of query({ prompt, options: options as any }) as any) {
        const m = msg as Record<string, unknown>;
        const t = m.type;

        // ── assistant message: walk content blocks, emit tool_use + text ──
        if (t === "assistant") {
          const message = m.message as
            | { content?: unknown[] }
            | undefined;
          const content = Array.isArray(message?.content) ? message!.content : [];
          for (const blockRaw of content) {
            const block = blockRaw as Record<string, unknown>;
            if (block?.type === "tool_use") {
              yield {
                type: "tool_use",
                tool_name: String(block.name ?? ""),
                tool_input: block.input,
                tool_use_id:
                  typeof block.id === "string" ? block.id : undefined,
              };
            } else if (block?.type === "text") {
              const text = String(block.text ?? "");
              if (text.length > 0) yield { type: "text", text };
            }
          }
          continue;
        }

        // ── tool_result blocks come back on a "user" message ──
        if (t === "user") {
          const message = m.message as { content?: unknown[] } | undefined;
          const content = Array.isArray(message?.content) ? message!.content : [];
          for (const blockRaw of content) {
            const block = blockRaw as Record<string, unknown>;
            if (block?.type === "tool_result") {
              yield {
                type: "tool_result",
                tool_use_id:
                  typeof block.tool_use_id === "string"
                    ? block.tool_use_id
                    : undefined,
                output: block.content,
              };
            }
          }
          continue;
        }

        // ── final result with cost + optional final text ──
        if (t === "result") {
          yield {
            type: "result",
            result: typeof m.result === "string" ? m.result : undefined,
            cost_usd:
              typeof m.total_cost_usd === "number"
                ? (m.total_cost_usd as number)
                : undefined,
            subtype: typeof m.subtype === "string" ? m.subtype : undefined,
            usage: m.usage,
          };
          continue;
        }

        // system / unknown message types — ignored
      }
    } catch (e) {
      yield { type: "error", error: (e as Error).message };
    }
  }
}
