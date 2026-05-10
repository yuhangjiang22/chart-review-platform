# Design: convert MCP from in-process to subprocess

**Branch:** `feat/mcp-subprocess`
**Status:** in progress
**Goal:** allow non-Anthropic agent providers (Codex, OpenAI direct,
Ollama, etc.) to connect to the platform's MCP tools. Codex only
supports subprocess MCP servers (per
`developers.openai.com/codex/mcp`).

## What we have today

`app/server/mcp-tools.ts` registers 7 tools via Anthropic SDK helpers
(`tool()` + `createSdkMcpServer()`). These run in-process: the same
Node.js process that runs the platform also dispatches MCP tool calls.

```
batch-run / chat session
    ↓ via @anthropic-ai/claude-agent-sdk
agent reads + decides + invokes a tool
    ↓ in-process JS function call
mcp-tools.ts handler
    ↓
review-state.ts → review_state.json on disk
```

Closure-captured state per server instance:
- `patientId` — the active patient
- `task` (CompiledTask) — the active rubric
- `sessionId` — for audit logging
- `hooks.onStateUpdate(state)` — WebSocket broadcast callback

## What changes

The handlers stay; only their *transport* changes. After this work:

```
batch-run / chat session
    ↓ via AgentProvider (Claude / Codex / etc.)
agent reads + decides + invokes a tool
    ↓ MCP-over-stdio (JSON-RPC)
chart-review-mcp-server (separate Node process)
    ↓ same handler functions
review-state.ts → review_state.json on disk
```

## The 7 tools (unchanged behavior)

| Tool | Purpose | Args | Returns |
|---|---|---|---|
| `set_field_assessment` | Commit one criterion answer | field_id, answer, confidence, evidence[], rationale, edit_reason?, edit_note?, override_of_agent? | success/failure CallToolResult |
| `get_review_state` | Read current review_state.json | (none) | JSON-stringified state |
| `set_summary` | Set the chart summary | summary | success/failure |
| `recommend_keywords` | Log suggested keywords | criterion_id, keywords[] | success/failure |
| `select_evidence` | Attach evidence to a field | field_id, evidence[] | success/failure |
| `find_quote_offsets` | Verify a quote's offsets in a note | note_id, snippet | offsets or error |
| `set_review_status` | Mark draft complete | (none) | success/failure |

## Plan (5 commits, ~5 hours)

**Commit 1 — this doc** (~30 min). Establishes the contract before
moving any code.

**Commit 2: Extract handlers to pure functions.** Move the body of
each `tool()` call into a top-level function in
`app/server/mcp-handlers.ts`. The signature accepts session context
explicitly:

```ts
export interface McpSession {
  patientId: string;
  task: CompiledTask;
  sessionId: string;
}

export async function setFieldAssessment(
  session: McpSession,
  args: SetFieldAssessmentArgs,
  hooks?: ReviewToolHooks,
): Promise<CallToolResult> { /* same body as today */ }
```

`mcp-tools.ts` continues to register tools via the Anthropic SDK
but delegates each handler to the pure function. Behavior unchanged.

**Risk:** Low. Pure refactor.

**Commit 3: Build the standalone subprocess server.** New file
`app/mcp-server/index.ts` that:

- Uses `@modelcontextprotocol/sdk` (the cross-vendor MCP server SDK)
- Reads session context from env vars: `CHART_REVIEW_MCP_PATIENT_ID`,
  `CHART_REVIEW_MCP_TASK_ID`, `CHART_REVIEW_MCP_SESSION_ID`
- Loads the compiled task at startup
- Registers the 7 handlers from `mcp-handlers.ts`
- Listens on stdio
- No WebSocket broadcast (the main server polls disk; broadcast not
  needed for batch agent runs)

`package.json` gains `@modelcontextprotocol/sdk` as a dependency and
a build target so the subprocess can be invoked as
`node dist/mcp-server.js` (or via tsx in dev).

**Risk:** Medium. New dependency, new entry point, new build step.

**Commit 4: Update Claude provider to spawn subprocess.**
`agent-provider-claude.ts` (and `compose-agent.ts`) spawn the
subprocess per agent invocation, pass session info via env vars,
clean up on exit. The Anthropic SDK's `mcpServers` field becomes a
**stdio command spec** instead of an in-process server object.

Two paths during transition:
- `MCP_TRANSPORT=in-process` (default for now) — current behavior
- `MCP_TRANSPORT=subprocess` — new behavior

Once verified, default flips to subprocess and in-process path is
removed in a later commit.

**Risk:** Medium. Touches the main agent loop. Mitigation:
opt-in via env var + smoke-test before flipping default.

**Commit 5: Smoke-test + flip default.** Run `iter_011` (1 patient,
1 agent) with `MCP_TRANSPORT=subprocess`, verify all the same checks
that iter_010 passed:
- 11 fields written to `agent_1.json`
- 7 leaves answered with evidence
- Derived rollup correct
- Audit trail captured
- Faithfulness gate enforced

If green: flip default + tag v0.6.0.

## Open design questions (resolved)

**Q: How does the subprocess get `patientId` / `task` / `sessionId`?**
Via env vars at spawn time. Per-call args were considered but rejected
— would force the agent to thread context through every tool call,
which is awkward. Codex's `[mcp_servers.X]` config supports `env_vars`
so this is portable.

**Q: How does the subprocess broadcast state changes to WebSocket
clients?** It doesn't. The main server polls disk on each request.
Real-time push isn't critical for batch agent runs (Studio already
polls `/api/runs/...` every few seconds). For the chat copilot
(`ai-client.ts`), in-process MCP stays available — its `getOutputStream`
already exposes raw SDK messages over WebSocket, so we don't migrate
it in this round.

**Q: One subprocess per agent run, or one long-lived subprocess?**
One per agent run. Per-(patient, agent) lifecycle:
- Spawn at agent run start, env vars carry session context
- Agent run completes (or times out) → kill subprocess
- ~90s lifetime, ~10 spawns per pilot iter
- Cheap on Linux/macOS; aligns with the existing model where
  `makeReviewMcpServer` is created fresh per session

## Non-goals for this round

- Migrating `ai-client.ts` (chat copilot) and `builder-session.ts`
  to subprocess MCP — they expose raw SDK messages to WebSocket
  consumers, see `agent-provider.ts` deferral comment
- Adding the actual `CodexAgentProvider` impl — separate commit
  after the MCP work is verified
- Hot-reload of MCP changes during dev — accept that subprocess
  changes need a server restart for now

## Files affected (after all 5 commits)

- new: `chart-review-platform/app/server/mcp-handlers.ts`
- new: `chart-review-platform/app/mcp-server/index.ts`
- new: `chart-review-platform/app/mcp-server/package.json` (or
  consolidated into `app/package.json` with a `bin` entry)
- modified: `chart-review-platform/app/server/mcp-tools.ts` —
  becomes a thin Anthropic-SDK wrapper around `mcp-handlers.ts`
- modified: `chart-review-platform/app/server/compose-agent.ts` —
  switches `mcpServers` shape based on `MCP_TRANSPORT`
- modified: `chart-review-platform/app/server/agent-provider-claude.ts`
- modified: `chart-review-platform/app/server/infra/batch-run/runs.ts` —
  passes new session info to provider
- modified: `chart-review-platform/app/package.json` — add
  `@modelcontextprotocol/sdk` dependency
