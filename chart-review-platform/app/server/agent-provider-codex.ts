// agent-provider-codex.ts — AgentProvider impl backed by OpenAI's
// Codex CLI (`codex exec --json`).
//
// Spawns the codex binary as a subprocess per agent run, parses the
// JSONL event stream on stdout, and translates each event to the
// platform's normalized `AgentEvent` taxonomy. The MCP tools are
// supplied by chart-review-platform's standalone stdio MCP server
// (configured per ~/.codex/config.toml or the equivalent project-
// scoped config); Codex itself spawns and manages that subprocess.
//
// JSONL event taxonomy (verified by docs/codex-cli-spike.md):
//   thread.started     {thread_id}                 → (internal, skipped)
//   turn.started       {}                           → (internal, skipped)
//   item.started       {id, type, …}                → tool_use (when type=command_execution)
//   item.completed     {id, type, …}                → tool_result | text | (skipped)
//   turn.completed     {usage: {input_tokens, output_tokens, …}}
//                                                   → result (with usage)
//   error              {message}                    → error
//
// Caveats:
//   - Codex doesn't return $ cost. Token counts only. Cost would be
//     computed client-side from a model-specific rate table; for now
//     we leave cost_usd undefined.
//   - System prompt is prepended to the user prompt (Codex's `-c
//     instructions=...` per-call override is documented but untested
//     and the prepend approach is portable across all providers).
//   - ChatGPT-account auth (the default) restricts which models work;
//     `gpt-5-codex` is rejected. Default model works.

import { spawn } from "node:child_process";
import readline from "node:readline";
import type {
  AgentProvider,
  AgentRunInput,
  AgentEvent,
} from "./agent-provider.js";

/**
 * Resolve the codex binary path. By default we look for it in the
 * user's npm global prefix; operators can override with
 * `CHART_REVIEW_CODEX_BIN`. We resolve at instantiation time so a
 * misconfigured path fails fast.
 */
function resolveCodexBin(): string {
  if (process.env.CHART_REVIEW_CODEX_BIN) return process.env.CHART_REVIEW_CODEX_BIN;
  // Best-effort defaults. The real production path should be on PATH
  // or set explicitly; leaving the bare name here lets `spawn` walk
  // PATH naturally.
  return "codex";
}

function combinePrompts(systemPrompt: string | undefined, userPrompt: string): string {
  if (!systemPrompt) return userPrompt;
  // Prepend system instructions as a clearly-labeled preamble.
  // Codex doesn't have a separate system-prompt field in its non-
  // interactive mode; this is the portable fallback.
  return `# System instructions\n${systemPrompt}\n\n# Task\n${userPrompt}`;
}

export class CodexAgentProvider implements AgentProvider {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const codexBin = resolveCodexBin();
    const args: string[] = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      // Non-interactive run: skip every approval gate (shell commands
      // AND MCP tool calls). Without this, codex cancels MCP tool calls
      // even with `-c approval_policy="never"` — that policy only
      // covers shell escalation, not MCP. The platform already isolates
      // each agent invocation per patient cwd, so the loss of codex's
      // own sandbox is acceptable here.
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      input.cwd,
    ];
    // Only pass -m when the model is plausibly something Codex can
    // route to. Anthropic-prefixed model IDs (`anthropic/claude-...`)
    // are common in CHART_REVIEW_MODEL when the platform was
    // configured for Anthropic via OpenRouter; passing those to
    // Codex would yield a 4xx. When in doubt, don't pass — let
    // Codex pick its own default.
    if (input.model && !input.model.startsWith("anthropic/")) {
      args.push("-m", input.model);
    }
    // The actual prompt is the last positional arg.
    args.push(combinePrompts(input.extraSystemPrompt, input.prompt));

    const extractedEnv = input.mcpServers ? extractMcpEnvVars(input.mcpServers) : {};
    const child = spawn(codexBin, args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        // Tell our MCP subprocess where the per-run reviews root is.
        // Codex's config.toml registers the MCP server with these
        // env vars passed through (see docs).
        ...extractedEnv,
      } as NodeJS.ProcessEnv,
      // stdin: ignore. If piped and not closed, `codex exec` reads
      // additional input from stdin and waits forever for EOF — we
      // already pass the full prompt as the last positional arg.
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Buffered queue so async iteration doesn't drop fast bursts.
    const queue: AgentEvent[] = [];
    let resolver: (() => void) | null = null;
    let done = false;
    let error: string | null = null;

    const push = (e: AgentEvent) => {
      queue.push(e);
      if (resolver) {
        const r = resolver;
        resolver = null;
        r();
      }
    };

    // Parse JSONL on stdout
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let pendingToolUseIds = new Map<string, { name: string; input: unknown }>();

    rl.on("line", (line) => {
      if (line.trim().length === 0) return;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        // Non-JSON lines (Codex sometimes emits banners) — ignore.
        return;
      }
      switch (evt.type) {
        case "item.started": {
          const item = evt.item;
          if (item?.type === "command_execution") {
            pendingToolUseIds.set(item.id, {
              name: "command_execution",
              input: { command: item.command },
            });
            push({
              type: "tool_use",
              tool_name: "command_execution",
              tool_input: { command: item.command },
              tool_use_id: item.id,
            });
          }
          // Other started types (agent_message starts as well in some
          // versions) are ignored — we only emit on completion.
          break;
        }
        case "item.completed": {
          const item = evt.item;
          if (!item) break;
          if (item.type === "command_execution") {
            push({
              type: "tool_result",
              tool_use_id: item.id,
              output: {
                aggregated_output: item.aggregated_output,
                exit_code: item.exit_code,
                status: item.status,
              },
            });
            pendingToolUseIds.delete(item.id);
          } else if (item.type === "agent_message") {
            const text = String(item.text ?? "");
            if (text.length > 0) push({ type: "text", text });
          }
          // Other item types (mcp tool calls, etc.) are not handled
          // explicitly yet — they'd need translation if we use them.
          break;
        }
        case "turn.completed": {
          push({
            type: "result",
            usage: evt.usage,
            // Codex doesn't return cost; would require a per-model rate
            // table to compute from token counts. Leave undefined.
          });
          break;
        }
        case "error": {
          const msg =
            typeof evt.message === "string"
              ? evt.message
              : JSON.stringify(evt);
          push({ type: "error", error: msg });
          break;
        }
        // thread.started, turn.started — internal; ignored
      }
    });

    rl.on("close", () => {
      done = true;
      if (resolver) {
        const r = resolver;
        resolver = null;
        r();
      }
    });

    child.on("error", (err) => {
      error = err.message;
      done = true;
      if (resolver) {
        const r = resolver;
        resolver = null;
        r();
      }
    });

    // Forward stderr so codex errors / banners surface in the server log.
    child.stderr.on("data", (chunk) => {
      process.stderr.write("[codex-stderr] " + chunk);
    });

    // Yield events as they arrive, then exit when stdout closes.
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        resolver = resolve;
      });
    }
    if (error) yield { type: "error", error };
  }
}

/**
 * The platform's call sites pass `mcpServers` as part of
 * AgentRunInput, but Codex doesn't accept MCP server configs at the
 * CLI — it reads them from `~/.codex/config.toml`. We can still
 * extract any session-context env vars our subprocess MCP server
 * needs (CHART_REVIEW_MCP_PATIENT_ID etc.) and pass them through
 * the agent run's env so the MCP subprocess Codex spawns inherits
 * them.
 */
function extractMcpEnvVars(
  mcpServers: Record<string, unknown>,
): Record<string, string> {
  const cfg = (mcpServers as any)?.chart_review_state;
  if (!cfg || typeof cfg !== "object") return {};
  const env = cfg.env as Record<string, string> | undefined;
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("CHART_REVIEW_MCP_") || k === "CHART_REVIEW_REVIEWS_ROOT") {
      out[k] = v;
    }
  }
  return out;
}
