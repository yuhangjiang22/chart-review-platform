# Spike: feasibility of swapping Claude Agent SDK → OpenAI Codex CLI

**Date:** 2026-05-09
**Branch:** `spike/codex-cli-feasibility`
**Goal:** verify Codex CLI works as a drop-in agent backend before
committing to a multi-day refactor.

## TL;DR

Feasible. The `codex exec --json` non-interactive command emits a
JSONL event stream we can translate into the same `AgentEvent`
taxonomy we'd use for Claude. All flags we need exist (`--cd`,
`--model`, `--sandbox`, `--ephemeral`, `-c key=value` for per-call
config overrides). One real gotcha: ChatGPT-account auth blocks
`gpt-5-codex`; default model works fine.

## What was verified

### CLI installation

```sh
npm i -g @openai/codex      # → 0.130.0
# Binary lands at $(npm prefix -g)/bin/codex
# Note: $(npm prefix -g)/bin may not be in PATH by default
```

### Authentication

User had `~/.codex/auth.json` already set up from prior work, with both
ChatGPT tokens and an `OPENAI_API_KEY`. Default `auth_mode: "chatgpt"`.
First exec call worked without re-auth.

### Per-call flags (verified by `codex exec --help`)

| Flag | Purpose |
|---|---|
| `--json` | JSONL events on stdout |
| `--ephemeral` | Don't persist session files |
| `--skip-git-repo-check` | Allow running outside a Git repo |
| `--ignore-user-config` | Don't merge `~/.codex/config.toml` |
| `-C, --cd <DIR>` | Working directory |
| `-m, --model <MODEL>` | Model selection |
| `-s, --sandbox <MODE>` | `read-only`, `workspace-write`, `danger-full-access` |
| `-c key=value` | Per-call TOML config override (e.g. `-c instructions="..."`) |
| `--output-schema <FILE>` | Force structured-output JSON |
| `-o, --output-last-message <FILE>` | Save final message to file |

### JSONL event stream (verified by two exec runs)

Captured event types from a trivial prompt:

```
{"type":"thread.started","thread_id":"<uuid>"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{
  "input_tokens":<n>,
  "cached_input_tokens":<n>,
  "output_tokens":<n>,
  "reasoning_output_tokens":<n>
}}
```

For tool-using prompts, additional events appear:

```
{"type":"item.started","item":{
  "id":"item_1",
  "type":"command_execution",
  "command":"/bin/zsh -lc 'cat sample.txt'",
  "aggregated_output":"",
  "exit_code":null,
  "status":"in_progress"
}}
{"type":"item.completed","item":{
  "id":"item_1",
  "type":"command_execution",
  "command":"/bin/zsh -lc 'cat sample.txt'",
  "aggregated_output":"test content\n",
  "exit_code":0,
  "status":"completed"
}}
```

Same `item.id` correlates `started` → `completed`. Final `agent_message`
follows the tool result.

**Notable absences vs Anthropic's stream:**

- No explicit cost in dollars; only token counts in `turn.completed.usage`.
  Cost has to be computed client-side from token counts × model rate.
- No `reasoning` text leakage (matches expected behavior — model's chain
  of thought is hidden).
- `item.started` is only emitted for items that take meaningful time
  (commands). Plain `agent_message` items go straight to `item.completed`.

### Auth mode caveat

ChatGPT-account auth (the default for users who signed in via the
browser flow) does NOT support all models. Concretely:

```
The 'gpt-5-codex' model is not supported when using Codex with a
ChatGPT account.
```

Default model works. To use specific models like `gpt-5-codex`, the
auth would need to switch to API-key mode (`auth_mode: "apikey"` in
`~/.codex/auth.json`, populated by `OPENAI_API_KEY`).

For the platform: `model-config.ts`'s `modelFor()` resolution should
default to a ChatGPT-compatible model when `auth_mode=chatgpt` is
detected, or operators must configure API-key mode upfront.

## What was NOT verified (deferred to actual implementation)

1. **System prompt mechanism.** Three candidates documented but not
   tested: (a) `-c instructions="..."` per-call override, (b) prepend
   to user prompt, (c) `~/.codex/config.toml` persistent. Likely (a)
   is the cleanest match for our `composeAgentOptions` semantics.

2. **MCP server end-to-end.** The docs say MCP servers are configured
   in `config.toml` and supported as subprocess (stdio/HTTP) only —
   not in-process. Did not actually wire up an MCP server during the
   spike. A real implementation would need to convert
   `app/server/mcp-tools.ts` from in-process registration to a
   standalone `chart-review-mcp-server` subprocess.

3. **`--output-schema` for structured JSON.** Could replace our
   sentinel-based JSON extraction in `judge.ts` and
   `override-suggester.ts`. Worth exploring during the actual port.

4. **Skill auto-discovery from `.agents/skills/`.** Codex docs say
   it scans `.agents/skills`, but this wasn't exercised — the spike
   prompts didn't trigger skill activation.

5. **Per-iter cost.** For our use case (judge batch on 23 cells),
   need to confirm whether ChatGPT auth has rate limits or
   consumption limits that'd block batch runs.

## Implementation plan (unchanged from pre-spike)

The spike confirms the original plan is sound:

| Step | Effort | Risk after spike |
|---|---|---|
| 1. Move skills from `.claude/skills/` → `.agents/skills/`, add `.claude/skills` symlink | 30 min | Low |
| 2. `AgentProvider` interface + `ClaudeAgentProvider` (wraps existing code) | 4h | Low |
| 3. Convert MCP from in-process to subprocess | 4–6h | Medium (mechanical, but touches many tool definitions) |
| 4. `CodexAgentProvider` impl: spawn `codex exec --json -C cwd -m model -c instructions=…`, parse JSONL, translate to `AgentEvent` | 4–6h | Lower than pre-spike — JSONL shape is now known |
| 5. `model-config.ts` adds OpenAI model defaults; auto-detect ChatGPT-vs-apikey auth mode | 1h | Low |
| 6. End-to-end smoke against both providers | 2h | Medium |
| **Total** | **~16–20h** | |

## Files left around by the spike

- `/tmp/codex-spike/` — empty workspace dir from minimal exec
- `/tmp/codex-spike-tools/` — `sample.txt` + minimal command exec
- `/tmp/codex-spike-jsonl.txt` — first run output

These can be deleted with `rm -rf /tmp/codex-spike*` once findings are
captured.

## What to do with this branch

This branch holds the doc but no code changes. Two options:

- **Merge to main** as a tracked spike record. Useful institutional memory.
- **Keep as a branch indefinitely.** Less log noise on main.

Recommendation: merge with `--no-ff` so the branch shape stays visible
in the log alongside the (eventual) actual port branch.
