# CLAUDE.md — chart-review-platform-concur

Read automatically by Claude Code at session start. Covers architecture,
conventions, and gotchas. For the full narrative, see `README.md`.

## What this project is

A trimmed fork of chart-review-platform-v2, extended back up toward parity.
**Three task kinds** — phenotype (`cancer-diagnosis`), NER (`bso-ad-ner`),
adherence (`asthma-adherence`) — clinical notes only, one agent provider
(`deepagents`). Phases: **AUTHOR · TRY · JUDGE (optional) · VALIDATE ·
PERFORMANCE** (LOCK/DEPLOY deferred). Plus an **automatic rubric
self-refinement loop** that improves the rubric from the reviewer's validated
annotations (error-analysis → propose → held-out-validate → human-applied,
revertable). Phenotype + adherence have the full loop; NER has
attribution+propose. See `server/lib/refine/` and
`docs/superpowers/plans/2026-06-13-refine-from-human-annotations.md`.

## Repo layout

```
chart-review-platform-concur/
├── .claude/skills/chart-review-cancer-diagnosis/   ← the rubric the SERVER reads
│   ├── SKILL.md, meta.yaml                            (guidelinesRoot() = <root>/.claude/skills)
│   └── references/criteria/{cancer_type,has_distant_metastasis,has_local_recurrence,disease_extent}.md
│       (disease_extent is a derived field: computed from the two has_* leaves)
├── .agents/skills/…                                ← PLATFORM_ROOT *marker* only (see gotcha #5);
│                                                      a SEPARATE, drifted copy — NOT read at runtime
├── client/               React 18 + Tailwind + Radix Studio UI
├── server/               Express + WebSocket (index.ts + route files)
├── packages/
│   ├── agent-provider-deepagents/  TS DeepAgentsProvider
│   ├── agent-provider/             AgentProvider interface
│   ├── mcp-server-stdio/           stdio MCP server (faithfulness gate)
│   ├── storage/                    atomic filesystem I/O
│   ├── domain-review/              review_state business logic
│   └── …
├── python/
│   ├── chart_review_deepagents/    Python sidecar (deepagents + langchain)
│   └── pyproject.toml              requires Python ≥3.11
├── corpus/               patient notes
└── var/                  runtime state (gitignored)
```

## Architecture in one screen

```
┌────────────┬───────────────────────────────────────────────────┐
│ React UI   │ Express + WebSocket server                        │
│ Studio +   │ ├─ packages/mcp-server-stdio  ← MCP over stdio    │
│ Workspace  │ └─ packages/agent-provider-deepagents             │
│ panes      │         spawns Python sidecar                     │
└────────────┴──────────────┬────────────────────────────────────┘
                             │
               python/chart_review_deepagents
                 ├─ langchain-mcp-adapters  (1 session / run)
                 ├─ Azure OpenAI (gpt-4o) or vLLM
                 └─ emits AgentEvents on stdout (JSONL)
```

Both halves coordinate through the **filesystem** (`var/reviews/`,
`var/runs/`), not in-memory.

Faithfulness gate at the MCP boundary verifies each cited quote is genuinely
present in the note. If the cited offsets are wrong but the quote IS found
(agents copy text faithfully yet mis-count offsets), it accepts and auto-corrects
the offsets; only quotes truly absent from the note are rejected.

## Modularization seams — use these in new code

| Seam | Location | Use when |
|---|---|---|
| **Agent invocation** | `packages/agent-provider-deepagents/src/index.ts` | Spawning the Python sidecar. Interface is `AgentProvider` from `packages/agent-provider`. Don't import the sidecar directly from server code — go through `runAgent()`. |
| **Workflow phases** | `client/src/ui/Workspace/phases.ts` | Adding/reordering Studio phases. Edit `PHASE_DEFS`; everything else (pill bar, router, headlines, slugs) derives. |
| **Filesystem I/O** | `packages/storage` | Reading/writing JSON state files. Use `atomicWriteJson`, `readJsonOrNull<T>`. New code MUST go through this. |
| **MCP tools** | `packages/mcp-server-stdio/src/index.ts` | Adding a new MCP tool for the agent. This is the stdio server that the Python sidecar connects to. |

## Python sidecar

The sidecar (`python/chart_review_deepagents`) requires Python 3.11+ and
a virtual environment:

```sh
cd python
uv venv .venv --python 3.11
uv pip install -e .
```

Point `DEEPAGENTS_PYTHON` in `.env` at the venv's python binary
(`/abs/path/python/.venv/bin/python`). The TS provider spawns it as a
subprocess; it loads MCP tools from the stdio server via
`langchain-mcp-adapters` and keeps one MCP session alive per patient run.

## Environment variables

See `.env.example` for the full list. Key vars:

- `AGENT_PROVIDER=deepagents` — selects the deepagents provider
- `MCP_TRANSPORT=subprocess` — sidecar spawns the stdio MCP server itself
- `DEEPAGENTS_PYTHON` — absolute path to the venv python binary
- `DEEPAGENTS_LLM_BACKEND=azure|vllm` — model backend
- `AZURE_OPENAI_*` — API key, endpoint, API version, deployment name
- `VLLM_BASE_URL`, `VLLM_MODEL`, `VLLM_API_KEY` — for vLLM backend
- `CHART_REVIEW_PLATFORM_ROOT` — absolute path to this checkout

## Workflow conventions

- **Feature branches**: `feat/...`, `fix/...`, `refactor/...`, `docs/...`
- **Conventional commits**: `<type>(<scope>): <summary>`. Body: motivation +
  context. End with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **No push**: this repo is local-only.
- **No skipping hooks**: no `--no-verify`.

## Common commands

```sh
# dev server (hot reload)
npm run dev

# typecheck
npm run typecheck

# build client
npm run build:client

# python tests
cd python && ./.venv/bin/python -m pytest -q
```

## Gotchas (intentional)

1. **`.gitignore` has `/workspace/` (anchored)**, not `workspace/`. The
   unanchored form silently drops `client/src/ui/Workspace/` on
   case-insensitive filesystems. Don't unanchor it.

2. **The Python sidecar holds one langchain-mcp-adapters session per
   patient run** (not per tool call). Opening a new session per call
   would add ~1 s of MCP handshake latency per tool. The sidecar keeps
   the session alive for the whole run and shuts it down on exit.

3. **Faithfulness parity**: `packages/mcp-server-stdio` enforces the
   faithfulness check in TypeScript (via `@chart-review/faithfulness`
   `verifyEvidence`: quote-presence with offset auto-correction). If you add a
   new write tool, route its note evidence through the same check. There is no
   Python-side parity copy for this (unlike the derivation evaluator in v2).

4. **`packages/mcp-server-stdio` is the MCP server the agent talks to.**
   `packages/mcp-server-anthropic` is still wired — but only for its
   `buildMcpServersConfig()` helper, which builds the *stdio subprocess*
   config (command/args/env) pointing at `mcp-server-stdio`. Its
   in-process Anthropic-SDK server path (`makeReviewMcpServer`) is dead,
   since deepagents always uses subprocess transport. `STDIO_SERVER_PATH`
   in that file must point at `mcp-server-stdio/src/index.ts`.

5. **`.claude/skills` is the rubric the server reads — NOT `.agents/skills`.**
   `guidelinesRoot()` resolves to `<PLATFORM_ROOT>/.claude/skills`, and all
   runtime state (pilots/, sessions/, refinement_log.jsonl) is written there.
   `.agents/skills` exists only as the marker `packages/patients` walks up to
   find PLATFORM_ROOT — it is **not** a symlink here (unlike the upstream
   monorepo's `chart-review-platform/`) and its content has **drifted** from
   `.claude/skills`. Edit a criterion/rubric under **`.claude/skills`** or the
   change is silently ignored. (Some package descriptions / loader comments
   still say `.agents/skills`; those are stale. The two trees' content is
   unreconciled — pick one as canonical before relying on the other.)
