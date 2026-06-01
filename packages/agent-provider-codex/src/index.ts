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
//   - Auth/routing is configured in ~/.codex/config.toml. The platform
//     ships pointing at OpenRouter (model_provider = "openrouter") so
//     any OpenRouter-served model works. Operators can switch to
//     ChatGPT-account auth (`codex login`) or a direct OpenAI API key
//     by editing that file; the provider code is auth-agnostic.

import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type {
  AgentProvider,
  AgentRunInput,
  AgentEvent,
} from "@chart-review/agent-provider";

/** Project root for resolving .codex/config.toml. Falls back to
 *  CHART_REVIEW_PLATFORM_ROOT env var, then process.cwd(). Callers
 *  that want full control can set CODEX_HOME directly in env. */
const PLATFORM_ROOT = process.env.CHART_REVIEW_PLATFORM_ROOT ?? process.cwd();

/**
 * Project-local CODEX_HOME so teammates don't need to manage
 * `~/.codex/config.toml` on their own machines. The codex CLI reads
 * config.toml + auth.json + writes sessions/logs here. We override at
 * spawn time so:
 *   - the repo's checked-in config.toml is the source of truth
 *   - codex's logs/sessions land in <repo>/.codex/ (gitignored) instead
 *     of clobbering the user's personal ~/.codex used by other projects
 *   - the user's existing ChatGPT-account login in ~/.codex stays
 *     untouched
 *
 * Override with the CODEX_HOME env var if you want codex to fall back
 * to your personal config (e.g. for ad-hoc debugging).
 */
const PROJECT_CODEX_HOME = path.join(PLATFORM_ROOT, ".codex");

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
    // Codex CLI on ChatGPT-account auth (the default after our
    // OpenRouter detour failed end-to-end on MCP) only accepts a
    // narrow set of OpenAI-native models. Foreign IDs like
    // anthropic/claude-* would 4xx; we skip -m for those and let
    // codex use its account default. openai/* IDs are also risky
    // (gpt-5-codex was rejected per the spike) — skip those too.
    // The dropdown's model chip is therefore informational only on
    // the codex path; to actually pick a model use the Claude
    // provider (Anthropic SDK over OpenRouter), which honors any
    // OpenRouter-supported model string.
    if (input.model && !input.model.includes("/")) {
      args.push("-m", input.model);
    }
    // The actual prompt is the last positional arg.
    args.push(combinePrompts(input.extraSystemPrompt, input.prompt));

    const extractedEnv = input.mcpServers ? extractMcpEnvVars(input.mcpServers) : {};
    const child = spawn(codexBin, args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        // Point codex at the project-local config.toml unless the
        // operator has explicitly set CODEX_HOME to override.
        CODEX_HOME: process.env.CODEX_HOME ?? PROJECT_CODEX_HOME,
        // The MCP server registration in config.toml resolves its
        // command path via $CHART_REVIEW_PLATFORM_ROOT — make sure
        // that's set so the bash -lc wrapper can expand it.
        CHART_REVIEW_PLATFORM_ROOT:
          process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT,
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
          if (!item) break;
          const t = item.type as string | undefined;
          // command_execution — shell invocations.
          if (t === "command_execution") {
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
            break;
          }
          // MCP tool invocations. Codex's stdout shape for these has
          // varied across versions — we accept the common names
          // (`mcp_tool_call`, `mcp_call`, `tool_call`, `function_call`)
          // and any item that carries a server+name pair. The agent
          // catalog identifies MCP tools as `<server>__<tool>`; we
          // surface them with the same naming so the transcript looks
          // identical to Claude's `mcp__chart_review_state__read_note`.
          const looksLikeMcp =
            t === "mcp_tool_call" ||
            t === "mcp_call" ||
            t === "tool_call" ||
            t === "function_call" ||
            (typeof t === "string" && t.startsWith("mcp_"));
          if (looksLikeMcp) {
            const server = item.server ?? item.mcp_server ?? "mcp";
            const toolName = item.name ?? item.tool ?? item.tool_name ?? t;
            const fullName = `mcp__${server}__${toolName}`;
            const args = item.arguments ?? item.args ?? item.input ?? {};
            const parsedArgs = (() => {
              if (typeof args === "string") {
                try { return JSON.parse(args); } catch { return { raw: args }; }
              }
              return args;
            })();
            pendingToolUseIds.set(item.id, { name: fullName, input: parsedArgs });
            push({
              type: "tool_use",
              tool_name: fullName,
              tool_input: parsedArgs,
              tool_use_id: item.id,
            });
            break;
          }
          // Unknown item.type — log once for future inspection. We
          // still write to the transcript as a generic tool_use so the
          // event isn't silently dropped.
          if (t && t !== "agent_message") {
            process.stderr.write(
              `[codex-provider] unknown item.started type='${t}'; surfacing as generic tool_use\n`,
            );
            pendingToolUseIds.set(item.id ?? "?", { name: t, input: item });
            push({
              type: "tool_use",
              tool_name: t,
              tool_input: item,
              tool_use_id: item.id,
            });
          }
          break;
        }
        case "item.completed": {
          const item = evt.item;
          if (!item) break;
          const t = item.type as string | undefined;
          if (t === "command_execution") {
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
            break;
          }
          if (t === "agent_message") {
            const text = String(item.text ?? "");
            if (text.length > 0) push({ type: "text", text });
            break;
          }
          // MCP / tool / function-call completions — same heuristics
          // as item.started. Emit a tool_result so the transcript pairs
          // the started/completed events.
          const looksLikeMcp =
            t === "mcp_tool_call" ||
            t === "mcp_call" ||
            t === "tool_call" ||
            t === "function_call" ||
            (typeof t === "string" && t.startsWith("mcp_"));
          if (looksLikeMcp) {
            const output =
              item.output ??
              item.result ??
              item.response ??
              { status: item.status };
            push({
              type: "tool_result",
              tool_use_id: item.id,
              output,
            });
            pendingToolUseIds.delete(item.id);
            break;
          }
          // Unknown completion — surface generically.
          if (t) {
            push({
              type: "tool_result",
              tool_use_id: item.id,
              output: item,
            });
            pendingToolUseIds.delete(item.id);
          }
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
  const out: Record<string, string> = {};
  // Each known server type contributes its session env vars. The codex
  // provider only carries the env across to the subprocess; the actual
  // MCP server registration (and thus tool surface) lives in
  // .codex/config.toml.
  for (const serverKey of [
    "chart_review_state",
    "chart_review_ner",
    "chart_review_adherence",
  ]) {
    const cfg = (mcpServers as Record<string, unknown>)[serverKey];
    if (!cfg || typeof cfg !== "object") continue;
    const env = (cfg as { env?: Record<string, string> }).env;
    if (!env) continue;
    for (const [k, v] of Object.entries(env)) {
      if (
        k.startsWith("CHART_REVIEW_MCP_") ||
        k.startsWith("CHART_REVIEW_NER_") ||
        k.startsWith("CHART_REVIEW_ADH_") ||
        k === "CHART_REVIEW_REVIEWS_ROOT"
      ) {
        out[k] = v;
      }
    }
  }
  return out;
}
