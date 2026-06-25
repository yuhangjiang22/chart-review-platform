# chart-review-platform-light Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `chart-review-platform-light` — a fork of `chart-review-platform-v2` that keeps only the phenotype task kind, reads clinical notes only, ships one pre-authored cancer-type/extent task, runs extraction exclusively through deepagents (Azure/vLLM backend), and supports only the agent-run → human-validation → performance-report pipeline.

**Architecture:** Copy v2 verbatim, then apply targeted strip/swap diffs. The React UI, Express+WS server, filesystem-as-state, note MCP tools, faithfulness gate, phenotype pipeline, and κ math are untouched. A new `agent-provider-deepagents` TS package spawns a Python sidecar (mirroring the Codex provider); the sidecar uses `deepagents` + `langchain-mcp-adapters` to drive the agent against v2's existing stdio MCP server, with an Azure/vLLM model factory.

**Tech Stack:** TypeScript (Node 22, Express, React 18, Vitest, Playwright), Python 3.11+ (`deepagents`, `langchain-openai`, `langchain-mcp-adapters`), MCP over stdio, Azure OpenAI / vLLM.

**Reference paths (in v2, all relative to `chart-review-platform-v2/`):**
- Provider interface: `packages/agent-provider/src/index.ts`
- Codex provider to mirror: `packages/agent-provider-codex/src/index.ts`
- MCP subprocess config builder: `packages/mcp-server-anthropic/src/index.ts:433` (`buildMcpServersConfig`)
- Stdio MCP server: `packages/mcp-server-stdio/src/index.ts`
- Phenotype run loop: `packages/infra-batch-run/src/runs.ts` (~line 767 builds `mcpServers`)
- Phases: `client/src/ui/Workspace/phases.ts` (`PHASE_DEFS`)
- Task-kind registry: `client/src/ui/Workspace/task-kind-registry.ts`
- Faithfulness (reused as-is): `packages/faithfulness/src/index.ts`

**Conventions (from CLAUDE.md):** feature branches, conventional commits ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`, no `--no-verify`, no `git push`. Run all commands from `chart-review-platform-light/` unless noted. After each phase, `npm run typecheck` must pass — dangling imports to deleted packages are the primary regression and the canary.

---

## Phase A — Fork & boot baseline

### Task A1: Create the light fork

**Files:**
- Create: `chart-review-platform-light/` (sibling of `chart-review-platform-v2/`)

- [ ] **Step 1: Copy v2 source, excluding heavy/gitignored dirs**

Run from the monorepo root (`<repo>`):

```bash
rsync -a --delete \
  --exclude node_modules \
  --exclude 'client/node_modules' \
  --exclude 'packages/*/node_modules' \
  --exclude .git \
  --exclude 'var/runs' --exclude 'var/reviews' --exclude 'var/exports' \
  --exclude 'var/proposals' --exclude 'var/calibration' --exclude 'var/logs' --exclude 'var/tmp' \
  --exclude '.codex/sessions' --exclude '.codex/.tmp' --exclude '.codex/tmp' --exclude '.codex/shell_snapshots' \
  --exclude test-results --exclude .DS_Store \
  chart-review-platform-v2/ chart-review-platform-light/
```

- [ ] **Step 2: Rename the package**

Edit `chart-review-platform-light/package.json`: change `"name": "chart-review-platform-v2"` to `"name": "chart-review-platform-light"`.

- [ ] **Step 3: Install dependencies**

Run: `cd chart-review-platform-light && npm install`
Expected: completes without error; `node_modules/` populated.

- [ ] **Step 4: Baseline typecheck (records the starting state)**

Run: `npm run typecheck`
Expected: PASS (this is the unmodified v2 codebase, so it should already typecheck).

- [ ] **Step 5: Commit**

```bash
cd <repo>
git add chart-review-platform-light
git commit -m "chore(light): fork chart-review-platform-v2 into chart-review-platform-light

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A2: Confirm the dev server boots

- [ ] **Step 1: Boot the dev server**

Run: `npm run dev` (background it or use a separate terminal). Wait ~10s.
Expected: server logs `:3002`, client on `:5174`, no crash.

- [ ] **Step 2: Hit the health/tasks endpoint**

Run: `curl -s http://localhost:3002/api/v2/tasks | head -c 300` (or the task-list endpoint; check `server/index.ts` route table if the path differs).
Expected: JSON response, not a connection error.

- [ ] **Step 3: Stop the server.** No commit (verification only).

---

## Phase B — Swap the agent provider to deepagents

### Task B1: Add `deepagents` to the provider type and selector

**Files:**
- Modify: `packages/agent-provider/src/index.ts`

- [ ] **Step 1: Widen `ProviderName` and the guards to deepagents-only**

Replace the provider-name block (currently `"claude" | "codex"`) with:

```ts
export type ProviderName = "deepagents";
export const PROVIDER_NAMES: ProviderName[] = ["deepagents"];

export function isProviderName(s: unknown): s is ProviderName {
  return s === "deepagents";
}
```

- [ ] **Step 2: Replace the `buildProvider` switch**

```ts
async function buildProvider(name: ProviderName): Promise<AgentProvider> {
  switch (name) {
    case "deepagents": {
      const { DeepAgentsProvider } = await import("@chart-review/agent-provider-deepagents");
      return new DeepAgentsProvider();
    }
  }
}
```

- [ ] **Step 3: Default the env var to deepagents**

In `defaultProviderName()`, change the fallback from `"claude"` to `"deepagents"`:

```ts
const raw = (process.env.AGENT_PROVIDER ?? "deepagents").toLowerCase();
```

- [ ] **Step 4: Typecheck (will fail — provider package not built yet)**

Run: `npm run typecheck`
Expected: FAIL with `Cannot find module '@chart-review/agent-provider-deepagents'`. This is the next task.

### Task B2: Scaffold the `agent-provider-deepagents` package

**Files:**
- Create: `packages/agent-provider-deepagents/package.json`
- Create: `packages/agent-provider-deepagents/tsconfig.json`
- Create: `packages/agent-provider-deepagents/src/index.ts`

- [ ] **Step 1: package.json** (copy the shape of `packages/agent-provider-codex/package.json`)

```json
{
  "name": "@chart-review/agent-provider-deepagents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@chart-review/agent-provider": "*",
    "@chart-review/agent-compose": "*"
  }
}
```

- [ ] **Step 2: tsconfig.json** (mirror codex provider's tsconfig exactly)

Copy `packages/agent-provider-codex/tsconfig.json` verbatim into the new package.

- [ ] **Step 3: Implement `DeepAgentsProvider`**

```ts
// agent-provider-deepagents.ts — AgentProvider backed by a Python
// deepagents sidecar. Mirrors CodexAgentProvider: spawn a subprocess,
// parse JSONL on stdout, translate to AgentEvents. The sidecar speaks
// our AgentEvent shape directly, so parsing is a JSON.parse + type
// check rather than a translation table.
//
// The sidecar launches v2's stdio MCP server itself (via
// langchain-mcp-adapters) using the chart_review_state config we pass
// through in the run spec — so faithfulness + the note tools + the
// set_field_assessment write path are reused verbatim.

import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProvider, AgentRunInput, AgentEvent } from "@chart-review/agent-provider";

const PLATFORM_ROOT = process.env.CHART_REVIEW_PLATFORM_ROOT ?? process.cwd();
const SIDECAR_CWD = path.join(PLATFORM_ROOT, "python");

function resolvePythonBin(): string {
  return process.env.DEEPAGENTS_PYTHON ?? "python3";
}

interface RunSpec {
  prompt: string;
  system_prompt: string;
  max_turns: number;
  mcp: unknown; // the chart_review_state stdio config {type,command,args,env}
}

const KNOWN_EVENT_TYPES = new Set(["tool_use", "tool_result", "text", "result", "error"]);

export class DeepAgentsProvider implements AgentProvider {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const mcp = (input.mcpServers as Record<string, unknown> | undefined)?.chart_review_state;
    if (!mcp) {
      yield { type: "error", error: "deepagents provider: no chart_review_state MCP config in mcpServers" };
      return;
    }
    const spec: RunSpec = {
      prompt: input.prompt,
      system_prompt: input.extraSystemPrompt ?? "",
      max_turns: input.maxTurns ?? 60,
      mcp,
    };
    const specPath = path.join(os.tmpdir(), `deepagents-runspec-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");

    const child = spawn(resolvePythonBin(), ["-m", "chart_review_deepagents", specPath], {
      cwd: SIDECAR_CWD,
      env: { ...process.env, CHART_REVIEW_PLATFORM_ROOT: PLATFORM_ROOT } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const queue: AgentEvent[] = [];
    let resolver: (() => void) | null = null;
    let done = false;
    let spawnError: string | null = null;
    const wake = () => { if (resolver) { const r = resolver; resolver = null; r(); } };
    const push = (e: AgentEvent) => { queue.push(e); wake(); };

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const s = line.trim();
      if (!s) return;
      let evt: any;
      try { evt = JSON.parse(s); } catch { return; } // ignore non-JSON banners
      if (evt && typeof evt.type === "string" && KNOWN_EVENT_TYPES.has(evt.type)) {
        push(evt as AgentEvent);
      }
    });
    rl.on("close", () => { done = true; try { fs.unlinkSync(specPath); } catch {} wake(); });
    child.on("error", (err) => { spawnError = err.message; done = true; wake(); });
    child.stderr.on("data", (chunk) => process.stderr.write("[deepagents-stderr] " + chunk));

    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => { resolver = resolve; });
    }
    if (spawnError) yield { type: "error", error: spawnError };
  }
}
```

- [ ] **Step 4: Install the new workspace package**

Run: `npm install`
Expected: `@chart-review/agent-provider-deepagents` symlinked into `node_modules/@chart-review/`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (the module now resolves).

- [ ] **Step 6: Commit**

```bash
cd <repo>
git add chart-review-platform-light/packages/agent-provider-deepagents chart-review-platform-light/packages/agent-provider/src/index.ts chart-review-platform-light/package-lock.json
git commit -m "feat(light): add DeepAgentsProvider and make deepagents the only provider

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B3: Route `buildMcpServersConfig` to subprocess for deepagents

**Files:**
- Modify: `packages/mcp-server-anthropic/src/index.ts:433` (`buildMcpServersConfig`)

- [ ] **Step 1: Update the provider type + subprocess trigger**

In `buildMcpServersConfig`, change the provider resolution and `wantsSubprocess` so deepagents always uses subprocess transport:

```ts
const provider = opts.provider
  ?? ((process.env.AGENT_PROVIDER ?? "deepagents").toLowerCase() as "deepagents");
const wantsSubprocess =
  process.env.MCP_TRANSPORT === "subprocess" || provider === "deepagents";
```

Also update `BuildMcpServersOptions.provider`'s type (declared earlier in this file) from `"claude" | "codex"` to `"deepagents"` so the cast above is sound. (The in-process `makeReviewMcpServer` branch becomes dead for the light platform but can stay; deepagents never hits it.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform-light/packages/mcp-server-anthropic/src/index.ts
git commit -m "feat(light): route MCP transport to subprocess for the deepagents provider

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B4: Remove the claude and codex providers

**Files:**
- Delete: `packages/agent-provider-claude/`
- Delete: `packages/agent-provider-codex/`
- Modify: any imports referencing them (the typecheck enumerates these)

- [ ] **Step 1: Delete the two provider packages**

```bash
cd chart-review-platform-light
rm -rf packages/agent-provider-claude packages/agent-provider-codex
```

- [ ] **Step 2: Find dangling references**

Run: `grep -rln "agent-provider-claude\|agent-provider-codex\|ClaudeAgentProvider\|CodexAgentProvider" packages server client --include='*.ts' --include='*.tsx' | grep -v node_modules`
Expected: a short list. For each hit, delete the import/usage (these were only referenced from `packages/agent-provider/src/index.ts`, which Task B1 already rewrote). If `ai-client.ts` or `builder-session.ts` import the Claude SDK directly, leave those — they are the deferred session-stored sites and do not go through the provider switch; confirm they still typecheck.

- [ ] **Step 3: Reinstall + typecheck**

Run: `npm install && npm run typecheck`
Expected: PASS. If FAIL, fix the dangling import the error names, then re-run.

- [ ] **Step 4: Commit**

```bash
cd <repo>
git add -A chart-review-platform-light
git commit -m "refactor(light): remove claude and codex agent providers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — Python deepagents sidecar

> Prerequisite: Python 3.11+. Local `python3` is 3.9.6 (too old for deepagents). Create a venv with a newer interpreter and point `DEEPAGENTS_PYTHON` at it.

### Task C1: Scaffold the Python package + venv

**Files:**
- Create: `python/pyproject.toml`
- Create: `python/chart_review_deepagents/__init__.py`

- [ ] **Step 1: pyproject.toml**

```toml
[project]
name = "chart-review-deepagents"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "deepagents",
  "langchain-openai",
  "langchain-mcp-adapters",
]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools]
packages = ["chart_review_deepagents"]
```

- [ ] **Step 2: Empty package init**

Create `python/chart_review_deepagents/__init__.py` containing a single comment line: `# chart-review-platform-light deepagents sidecar`.

- [ ] **Step 3: Create venv + install**

```bash
cd chart-review-platform-light/python
python3.11 -m venv .venv   # or: uv venv --python 3.11 .venv
./.venv/bin/pip install -e .
echo "DEEPAGENTS_PYTHON=$(pwd)/.venv/bin/python"   # note this value for .env
```
Expected: install succeeds; record the venv python path.

- [ ] **Step 4: Pin the installed API**

Run: `./.venv/bin/python -c "import deepagents, langchain_mcp_adapters, langchain_openai; from deepagents import create_deep_agent; from langchain_mcp_adapters.client import MultiServerMCPClient; print('ok')"`
Expected: prints `ok`. If `create_deep_agent` or `MultiServerMCPClient` import paths differ in the installed version, adjust `models.py`/`__main__.py` below to match before proceeding.

- [ ] **Step 5: Commit**

```bash
cd <repo>
git add chart-review-platform-light/python/pyproject.toml chart-review-platform-light/python/chart_review_deepagents/__init__.py
git commit -m "feat(light): scaffold python deepagents sidecar package

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task C2: Model factory

**Files:**
- Create: `python/chart_review_deepagents/models.py`
- Test: `python/tests/test_models.py`

- [ ] **Step 1: Write the failing test**

```python
# python/tests/test_models.py
import os
import pytest
from chart_review_deepagents.models import make_model

def test_unknown_backend_raises():
    os.environ["DEEPAGENTS_LLM_BACKEND"] = "nope"
    with pytest.raises(SystemExit):
        make_model()

def test_vllm_requires_base_url(monkeypatch):
    monkeypatch.setenv("DEEPAGENTS_LLM_BACKEND", "vllm")
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
    with pytest.raises(KeyError):
        make_model()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd chart-review-platform-light/python && ./.venv/bin/python -m pytest tests/test_models.py -q`
Expected: FAIL with `ModuleNotFoundError: chart_review_deepagents.models`.

- [ ] **Step 3: Implement `models.py`**

```python
# chart_review_deepagents/models.py
import os
import sys

def make_model():
    """Build a LangChain chat model from env. Backend selected by
    DEEPAGENTS_LLM_BACKEND = azure | vllm. Returns a BaseChatModel
    that create_deep_agent accepts directly."""
    backend = os.environ.get("DEEPAGENTS_LLM_BACKEND", "azure").lower()
    if backend == "azure":
        from langchain_openai import AzureChatOpenAI
        return AzureChatOpenAI(
            azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
            api_key=os.environ["AZURE_OPENAI_API_KEY"],
            api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21"),
            azure_deployment=os.environ["AZURE_OPENAI_DEPLOYMENT"],
            temperature=0,
        )
    if backend == "vllm":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            base_url=os.environ["VLLM_BASE_URL"],
            api_key=os.environ.get("VLLM_API_KEY", "EMPTY"),
            model=os.environ["VLLM_MODEL"],
            temperature=0,
        )
    print(f"[deepagents] Unknown DEEPAGENTS_LLM_BACKEND={backend!r} (expected azure|vllm)", file=sys.stderr)
    raise SystemExit(2)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_models.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
cd <repo>
git add chart-review-platform-light/python/chart_review_deepagents/models.py chart-review-platform-light/python/tests/test_models.py
git commit -m "feat(light): deepagents model factory (azure|vllm)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task C3: Event emitter (LangGraph messages → AgentEvent JSONL)

**Files:**
- Create: `python/chart_review_deepagents/events.py`
- Test: `python/tests/test_events.py`

- [ ] **Step 1: Write the failing test**

```python
# python/tests/test_events.py
import json, io
from langchain_core.messages import AIMessage, ToolMessage
from chart_review_deepagents.events import messages_to_events

def test_ai_text_and_tool_call():
    msg = AIMessage(content="hello", tool_calls=[
        {"name": "read_note", "args": {"note_id": "n1"}, "id": "tc1"}
    ])
    events = list(messages_to_events([msg]))
    assert {"type": "text", "text": "hello"} in events
    assert any(e["type"] == "tool_use" and e["tool_name"] == "read_note"
               and e["tool_use_id"] == "tc1" for e in events)

def test_tool_message():
    msg = ToolMessage(content="note body", tool_call_id="tc1")
    events = list(messages_to_events([msg]))
    assert events == [{"type": "tool_result", "tool_use_id": "tc1", "output": "note body"}]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_events.py -q`
Expected: FAIL with `ModuleNotFoundError: chart_review_deepagents.events`.

- [ ] **Step 3: Implement `events.py`**

```python
# chart_review_deepagents/events.py
import sys, json
from langchain_core.messages import AIMessage, ToolMessage

def messages_to_events(messages):
    """Yield AgentEvent dicts for a list of LangChain messages.
    Mirrors packages/agent-provider's AgentEvent taxonomy."""
    for m in messages:
        if isinstance(m, AIMessage):
            text = m.content if isinstance(m.content, str) else _stringify(m.content)
            if text:
                yield {"type": "text", "text": text}
            for tc in (m.tool_calls or []):
                yield {
                    "type": "tool_use",
                    "tool_name": tc.get("name", "unknown"),
                    "tool_input": tc.get("args", {}),
                    "tool_use_id": tc.get("id"),
                }
        elif isinstance(m, ToolMessage):
            yield {
                "type": "tool_result",
                "tool_use_id": m.tool_call_id,
                "output": m.content if isinstance(m.content, str) else _stringify(m.content),
            }

def _stringify(content):
    # content can be a list of blocks for some providers
    try:
        return "".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
    except TypeError:
        return str(content)

def emit(event: dict):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_events.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
cd <repo>
git add chart-review-platform-light/python/chart_review_deepagents/events.py chart-review-platform-light/python/tests/test_events.py
git commit -m "feat(light): map LangGraph messages to AgentEvent JSONL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task C4: Sidecar entrypoint

**Files:**
- Create: `python/chart_review_deepagents/__main__.py`

- [ ] **Step 1: Implement `__main__.py`**

```python
# chart_review_deepagents/__main__.py
# Usage: python -m chart_review_deepagents <runspec.json>
#
# Run spec shape (written by DeepAgentsProvider):
#   { "prompt": str, "system_prompt": str, "max_turns": int,
#     "mcp": { "command": str, "args": [str], "env": {str:str}, "type": "stdio" } }
#
# Emits AgentEvent JSONL on stdout (one event per line). All diagnostics
# go to stderr — stdout is reserved for the event stream.
import asyncio, json, sys, traceback

from langchain_mcp_adapters.client import MultiServerMCPClient
from deepagents import create_deep_agent

from .models import make_model
from .events import messages_to_events, emit

async def run(spec: dict) -> None:
    mcp = spec["mcp"]
    client = MultiServerMCPClient({
        "chart_review_state": {
            "command": mcp["command"],
            "args": mcp["args"],
            "env": mcp.get("env", {}),
            "transport": "stdio",
        }
    })
    tools = await client.get_tools()
    agent = create_deep_agent(
        model=make_model(),
        tools=tools,
        system_prompt=spec.get("system_prompt", ""),
    )
    seen = 0
    last_text = ""
    config = {"recursion_limit": int(spec.get("max_turns", 60)) * 2 + 10}
    async for chunk in agent.astream(
        {"messages": [{"role": "user", "content": spec["prompt"]}]},
        stream_mode="values",
        config=config,
    ):
        msgs = chunk.get("messages", [])
        # stream_mode="values" yields the full message list each step;
        # only emit the newly-appended tail.
        for ev in messages_to_events(msgs[seen:]):
            if ev["type"] == "text":
                last_text = ev["text"]
            emit(ev)
        seen = len(msgs)
    emit({"type": "result", "result": last_text})

def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python -m chart_review_deepagents <runspec.json>", file=sys.stderr)
        raise SystemExit(2)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        spec = json.load(f)
    try:
        asyncio.run(run(spec))
    except Exception as e:  # surface any failure as an AgentEvent error
        traceback.print_exc()
        emit({"type": "error", "error": f"{type(e).__name__}: {e}"})
        raise SystemExit(1)

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke-parse the module (no run yet)**

Run: `./.venv/bin/python -c "import chart_review_deepagents.__main__ as m; print('ok')"`
Expected: prints `ok` (imports resolve). End-to-end run is verified in Task G3 after the task bundle exists.

- [ ] **Step 3: Commit**

```bash
cd <repo>
git add chart-review-platform-light/python/chart_review_deepagents/__main__.py
git commit -m "feat(light): deepagents sidecar entrypoint (MCP tools + astream)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — Notes-only (remove OMOP / structured data)

### Task D1: Strip OMOP tools from the stdio MCP server

**Files:**
- Modify: `packages/mcp-server-stdio/src/index.ts` (the `list_structured_data` and `read_structured_data` registrations, ~lines 303–337)

- [ ] **Step 1: Remove the two structured-data tool registrations**

Delete the `server.registerTool("list_structured_data", …)` and `server.registerTool("read_structured_data", …)` blocks. Also remove their now-unused imports (`listStructuredDataTool as hListStructured`, `readStructuredDataTool as hReadStructured`) from the `@chart-review/mcp-core` import list.

- [ ] **Step 2: Typecheck**

Run: `cd chart-review-platform-light && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Verify the tool list no longer advertises OMOP**

Run: `grep -nE '"(list_notes|read_note|read_notes|search_notes|list_structured_data|read_structured_data|set_field_assessment|get_review_state)"' packages/mcp-server-stdio/src/index.ts`
Expected: note tools + `set_field_assessment` + `get_review_state` present; **no** `list_structured_data`/`read_structured_data`.

- [ ] **Step 4: Commit**

```bash
cd <repo>
git add chart-review-platform-light/packages/mcp-server-stdio/src/index.ts
git commit -m "feat(light): notes-only — drop OMOP tools from stdio MCP server

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task D2: Drop OMOP corpus + structured-data prompt lines

**Files:**
- Delete: `corpus/patients/*/omop/`
- Modify: `packages/infra-batch-run/src/runs.ts` (phenotype prompt, ~lines 699–705)

- [ ] **Step 1: Remove OMOP fixtures from the corpus**

```bash
cd chart-review-platform-light
rm -rf corpus/patients/*/omop
```

- [ ] **Step 2: Trim structured-data lines from the phenotype prompt**

In `packages/infra-batch-run/src/runs.ts`, in `phenotypePrompt`, remove the references to `list_structured_data` / `read_structured_data` (the bullet under "For ANY chart content"). Keep the note tools (`list_notes`, `read_notes`/`read_note`) and `list_criteria`/`read_criteria` lines. The line should read notes-only:

```ts
"- For ANY chart content (clinical notes): use the chart_review_state",
"  MCP tools — `list_notes`, `read_notes` / `read_note`. Do NOT",
"  `cat`/`sed`/`ls`/`rg` the filesystem to read patient files.",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd <repo>
git add -A chart-review-platform-light/corpus chart-review-platform-light/packages/infra-batch-run/src/runs.ts
git commit -m "feat(light): notes-only — drop OMOP corpus fixtures + prompt lines

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase E — Remove NER + adherence task kinds

### Task E1: Delete NER + adherence packages

**Files:**
- Delete: `packages/mcp-core-ner`, `packages/mcp-core-adherence`, `packages/mcp-server-ner-anthropic`, `packages/mcp-server-ner-stdio`, `packages/mcp-server-adherence-anthropic`, `packages/mcp-server-adherence-stdio`, `packages/pipeline-extract-ner`, `packages/pipeline-extract-adherence`, `packages/eval-span-iaa`, `packages/eval-adherence-iaa`, `packages/benchmark-generator` (NER-only)

- [ ] **Step 1: Delete the packages**

```bash
cd chart-review-platform-light
rm -rf packages/mcp-core-ner packages/mcp-core-adherence \
       packages/mcp-server-ner-anthropic packages/mcp-server-ner-stdio \
       packages/mcp-server-adherence-anthropic packages/mcp-server-adherence-stdio \
       packages/pipeline-extract-ner packages/pipeline-extract-adherence \
       packages/eval-span-iaa packages/eval-adherence-iaa
```

(Leave `packages/benchmark-generator` for now; only delete it if Step 3's typecheck shows it is NER-only and unreferenced.)

- [ ] **Step 2: Delete NER/adherence skill bundles + corpus**

```bash
rm -rf .agents/skills/chart-review-*-ner .agents/skills/chart-review-ner* \
       .agents/skills/chart-review-*adherence* .agents/skills/chart-review-bso-ad* \
       .agents/skills/chart-review-ad-cde-ner
rm -rf corpus/patients/patient_fake_asthma_01 corpus/patients/patient_real_acts_01
```

- [ ] **Step 3: Reinstall + typecheck to enumerate danglers**

Run: `npm install && npm run typecheck 2>&1 | tee /tmp/light-tsc.txt | tail -40`
Expected: FAIL with a list of unresolved imports (server routes + UI panes that import the deleted packages). The next tasks clear them.

### Task E2: Remove NER/adherence server routes + run-loop branches

**Files:**
- Delete: `server/adherence-routes.ts`, `server/adherence-iaa-routes.ts`, `server/adherence-stats-routes.ts`, `server/adherence-summary-routes.ts`, `server/ner-calibration-routes.ts`, `server/span-stats-routes.ts`, `server/ontology-routes.ts`, `server/entity-type-guidance-routes.ts`
- Modify: `server/index.ts` (remove their imports + `.use()` registrations)
- Modify: `packages/infra-batch-run/src/runs.ts` (remove `isNerTask`/`isAdherenceTask` branches)

- [ ] **Step 1: Delete the route files**

```bash
cd chart-review-platform-light/server
rm -f adherence-routes.ts adherence-iaa-routes.ts adherence-stats-routes.ts \
      adherence-summary-routes.ts ner-calibration-routes.ts span-stats-routes.ts \
      ontology-routes.ts entity-type-guidance-routes.ts
```

- [ ] **Step 2: Remove their imports + registrations from `server/index.ts`**

Delete every `import { … } from "./adherence-*"`, `./ner-*`, `./span-stats-*`, `./ontology-*`, `./entity-type-guidance-*` line and the matching `router.use(...)` / `addRoutes(...)` calls. (Search: `grep -nE "adherence|ner-calibration|span-stats|ontology|entity-type-guidance" server/index.ts`.)

- [ ] **Step 3: Collapse the run loop to phenotype-only**

In `packages/infra-batch-run/src/runs.ts`: delete the `const isNerTask = …` and `const isAdherenceTask = …` declarations, the `buildNerPromptForNote` function, the `if (isAdherenceTask) { … }` block, the NER per-note loop, and the ternaries that switch on them. The `mcpServers` build becomes unconditional:

```ts
const mcpServers: Record<string, unknown> = buildMcpServersConfig(
  patientId, task, sessionId, { onStateUpdate: () => {} },
  { reviewsRoot: scratchRoot, provider: manifest.provider },
);
```

The `userPrompt` becomes simply `phenotypePrompt`, and `extraSystem` becomes the phenotype batch-mode string (drop the NER branch).

- [ ] **Step 4: Reinstall + typecheck**

Run: `cd chart-review-platform-light && npm install && npm run typecheck 2>&1 | tail -40`
Expected: remaining failures are now UI-side (Task E3). Server-side imports resolve.

- [ ] **Step 5: Commit (server side)**

```bash
cd <repo>
git add -A chart-review-platform-light/server chart-review-platform-light/packages chart-review-platform-light/.agents chart-review-platform-light/corpus chart-review-platform-light/package-lock.json
git commit -m "refactor(light): remove NER + adherence packages, routes, and run-loop branches

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task E3: Remove NER/adherence UI panes + registry entries

**Files:**
- Delete: `client/src/ui/SpanReview.tsx`, `client/src/ui/AdherenceReview.tsx`, `client/src/ui/Workspace/PhaseSpanAuthor.tsx`, `client/src/ui/Workspace/PhaseAdherenceAuthor.tsx`, `client/src/ui/Workspace/AdherenceDecideSummary.tsx`, `client/src/ui/Workspace/NerCalibrationFigure.tsx`
- Modify: `client/src/ui/Workspace/task-kind-registry.ts`, `client/src/ui/App.tsx`, `client/src/types.ts`

- [ ] **Step 1: Delete the panes**

```bash
cd chart-review-platform-light/client/src/ui
rm -f SpanReview.tsx AdherenceReview.tsx \
      Workspace/PhaseSpanAuthor.tsx Workspace/PhaseAdherenceAuthor.tsx \
      Workspace/AdherenceDecideSummary.tsx Workspace/NerCalibrationFigure.tsx
```

- [ ] **Step 2: Reduce `TaskKind` + the registry to phenotype**

In `client/src/ui/Workspace/task-kind-registry.ts`:
- Change `export type TaskKind = "phenotype" | "ner" | "adherence";` to `export type TaskKind = "phenotype";`
- Remove the `import { PhaseSpanAuthor }`, `PhaseAdherenceAuthor`, `SpanReview`, `AdherenceReview` lines.
- Remove the `ner` and `adherence` entries from the registry object, keeping only `phenotype: { authorPane: PhaseDraft, reviewerPane: PatientReview, unitLabel: {...} }`.

- [ ] **Step 3: Clear UI danglers guided by typecheck**

Run: `npm run typecheck 2>&1 | tail -40` (from `chart-review-platform-light`).
For each error: remove `task_kind === "ner"` / `=== "adherence"` branches in `App.tsx` and any pane that imported the deleted components. Where a component branches on `taskKind` for judge/decide/lock, keep only the phenotype branch.

- [ ] **Step 4: Typecheck until clean**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd <repo>
git add -A chart-review-platform-light/client
git commit -m "refactor(light): remove NER + adherence UI panes and registry entries

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase F — Reduce phases to TRY → VALIDATE → DECIDE

### Task F1: Trim `PHASE_DEFS`

**Files:**
- Modify: `client/src/ui/Workspace/phases.ts`
- Test: `client/src/ui/Workspace/phase-logic.test.ts` (already exists)

- [ ] **Step 1: Update the existing phase-logic test to the new set**

In `phase-logic.test.ts`, change any assertion enumerating phases to expect exactly `["TRY", "VALIDATE", "DECIDE"]` (drop AUTHOR/JUDGE/LOCK/DEPLOY). If the test asserts a `Phase` union member that no longer exists, update it.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd chart-review-platform-light && npx vitest run client/src/ui/Workspace/phase-logic.test.ts --reporter=dot`
Expected: FAIL (still seven phases).

- [ ] **Step 3: Reduce `PHASE_DEFS`**

Replace the `PHASE_DEFS` array with:

```ts
export const PHASE_DEFS: PhaseDef[] = [
  { id: "TRY", label: "Try", slug: "try", group: "iter" },
  { id: "VALIDATE", label: "Validate", slug: "validate", group: "iter" },
  { id: "DECIDE", label: "Performance", slug: "decide", group: "iter" },
];
```

Update the `Phase` type union (wherever it is declared in this file) to `"TRY" | "VALIDATE" | "DECIDE"`. Remove any `optional: true` plumbing that only served JUDGE if it now references a missing member.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run client/src/ui/Workspace/phase-logic.test.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Typecheck (enumerates panes referencing dropped phases)**

Run: `npm run typecheck 2>&1 | tail -40`
Expected: FAIL listing references to `"AUTHOR"|"JUDGE"|"LOCK"|"DEPLOY"`. Cleared in Task F2.

### Task F2: Delete dropped-phase panes + routes

**Files:**
- Delete: `client/src/ui/Workspace/PhaseDraft.tsx` is the AUTHOR pane — **keep** it only if the registry still points at it. Since AUTHOR is dropped, delete: `client/src/ui/Workspace/PhaseJudge.tsx`, `client/src/ui/Workspace/PhaseLock.tsx`, `client/src/ui/Workspace/PhaseDeploy.tsx`, `client/src/ui/Workspace/DeployRunFolder.tsx`, `client/src/ui/Workspace/AuthorPreFlight.tsx`
- Modify: `client/src/ui/Workspace/index.tsx` (phase router switch)
- Delete (server): `server/methods-routes.ts`, `server/lock-test-routes.ts`, `server/deploy-routes.ts`, `server/guideline-routes.ts` and their registrations in `server/index.ts`
- Modify: `client/src/ui/Workspace/task-kind-registry.ts` (the `authorPane` field becomes unused)

- [ ] **Step 1: Resolve the AUTHOR pane**

The task ships pre-authored (Phase G), so AUTHOR is not in the pill bar. In `task-kind-registry.ts`, remove the `authorPane` field from the registry type + entry. Delete `Workspace/PhaseDraft.tsx`, `Workspace/AuthorPreFlight.tsx` and remove their imports.

- [ ] **Step 2: Delete the JUDGE/LOCK/DEPLOY panes + server routes**

```bash
cd chart-review-platform-light
rm -f client/src/ui/Workspace/PhaseJudge.tsx client/src/ui/Workspace/PhaseLock.tsx \
      client/src/ui/Workspace/PhaseDeploy.tsx client/src/ui/Workspace/DeployRunFolder.tsx
rm -f server/methods-routes.ts server/lock-test-routes.ts server/deploy-routes.ts server/guideline-routes.ts
```

- [ ] **Step 3: Remove their imports + registrations from `server/index.ts` and `Workspace/index.tsx`**

In `server/index.ts`: delete imports + `router.use`/`addRoutes` for `methods-routes`, `lock-test-routes`, `deploy-routes`, `guideline-routes`.
In `Workspace/index.tsx`: the phase router switch should map only `TRY → PhaseTry`, `VALIDATE → PhaseValidate`, `DECIDE → PhaseDecide`. Delete the `case "AUTHOR"` / `"JUDGE"` / `"LOCK"` / `"DEPLOY"` arms and their imports.

- [ ] **Step 4: Reinstall + typecheck until clean**

Run: `npm install && npm run typecheck 2>&1 | tail -40`
Expected: PASS. Fix any remaining named references the compiler reports (e.g. a `PHASE_LABELS["LOCK"]` lookup) by deleting that dead code.

- [ ] **Step 5: Run the full client test suite for regressions**

Run: `npx vitest run --reporter=dot`
Expected: PASS (NER/adherence/phase tests already removed or updated).

- [ ] **Step 6: Commit**

```bash
cd <repo>
git add -A chart-review-platform-light
git commit -m "feat(light): reduce phases to TRY → VALIDATE → DECIDE; drop author/judge/lock/deploy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase G — The pre-authored cancer-type/extent task

> The deepagents agent has no Skill tool, so rubric scope is delivered through the `list_criteria` / `read_criteria` MCP tools (already in the stdio server). The two field YAMLs below ARE the rubric the agent reads at runtime. `SKILL.md` is minimal/vestigial but kept for parity with the loader.

### Task G1: Author the task bundle

**Files:**
- Create: `.agents/skills/chart-review-lung-cancer-phenotype-light/meta.yaml`
- Create: `.agents/skills/chart-review-lung-cancer-phenotype-light/SKILL.md`
- Create: `.agents/skills/chart-review-lung-cancer-phenotype-light/references/criteria/cancer_type.md`
- Create: `.agents/skills/chart-review-lung-cancer-phenotype-light/references/criteria/disease_extent.md`

- [ ] **Step 1: meta.yaml** (model the `task_kind`/`phases` shape on the existing lung-cancer-phenotype `meta.yaml`)

```yaml
task_kind: phenotype
task_type: phenotype_validation
review_unit: patient
manual_version: 2026-06-06
final_output: cancer_characterization
overview_prose: >-
  Extract two categorical fields per patient from clinical notes only:
  the cancer histology type and the disease extent. Source-document
  priority: surgical pathology > biopsy pathology > treating-oncologist
  progress notes > imaging reports.
phases:
  - try
  - validate
  - decide
```

- [ ] **Step 2: cancer_type criterion** (the `answer_schema.enum` is what the reviewer UI renders and what the agent must choose from)

```markdown
---
field_id: cancer_type
schema_hash: REGENERATE
prompt: What is the cancer histology type documented for this patient?
answer_schema:
  enum:
  - squamous_cell_carcinoma
  - adenocarcinoma
  - lymphoma
  - sarcoma
  - melanoma
  - neuroendocrine_tumor
  - no_info
cardinality: one
group: characterization
---

# Criterion: cancer_type

## Definition
The histologic type of the primary malignancy as documented by pathology
(preferred) or the treating oncologist.

## Extraction guidance
Prefer the surgical/biopsy pathology final diagnosis. Map descriptive
terms to the enum (e.g. "small cell carcinoma" / "carcinoid" → neuroendocrine_tumor;
"adenocarcinoma of the lung" → adenocarcinoma). Use `no_info` when no
note states a histology.

## Examples
- "Final diagnosis: Squamous cell carcinoma, moderately differentiated" → `squamous_cell_carcinoma`
- "Adenocarcinoma of the lung, T2N1M0" → `adenocarcinoma`
- Imaging-only workup, no pathology, no stated histology → `no_info`
```

- [ ] **Step 3: disease_extent criterion**

```markdown
---
field_id: disease_extent
schema_hash: REGENERATE
prompt: What is the documented extent of disease?
answer_schema:
  enum:
  - local_recurrent
  - local_recurrent_and_metastatic
  - metastatic
  - no_info
cardinality: one
group: characterization
---

# Criterion: disease_extent

## Definition
The spread of disease at the index assessment.

## Extraction guidance
`metastatic` = distant spread documented. `local_recurrent` = recurrence
at/near the primary site without distant spread. `local_recurrent_and_metastatic`
= both a local recurrence AND distant metastasis are documented. Use
`no_info` when extent is not stated.

## Examples
- "New hepatic and osseous metastases" → `metastatic`
- "Local recurrence at the surgical margin; no distant disease" → `local_recurrent`
- "Recurrence at primary site plus new lung metastases" → `local_recurrent_and_metastatic`
- Notes describe initial workup with no extent statement → `no_info`
```

- [ ] **Step 4: SKILL.md** (minimal — the rubric travels via MCP criteria tools)

```markdown
---
name: chart-review-lung-cancer-phenotype-light
description: >
  Extract cancer histology type and disease extent from a patient's
  clinical notes. Two categorical fields, evidence-cited.
---

# Procedure
1. `list_notes`, then `read_notes` to read all of the patient's notes.
2. `list_criteria` + `read_criteria(["cancer_type","disease_extent"])` for the enums + guidance.
3. For each field, `set_field_assessment(field_id, answer, confidence, evidence, rationale)`.
   Quote verbatim note text in `evidence` so the faithfulness gate passes.
4. Emit a one-line summary and stop.
```

- [ ] **Step 5: Commit**

```bash
cd <repo>
git add chart-review-platform-light/.agents/skills/chart-review-lung-cancer-phenotype-light
git commit -m "feat(light): pre-authored cancer-type/extent phenotype task

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task G2: Compile the task + register it in the task index

**Files:**
- Modify: corpus/task registration as the platform expects (check how v2 discovers tasks — `loadCompiledTask(taskId)` in `packages/tasks`)
- Test: a node script asserting the task compiles

- [ ] **Step 1: Find how tasks are discovered/compiled**

Run: `grep -rn "loadCompiledTask\|listTasks\|compileTask\|task_kind" packages/tasks/src/*.ts | head -20`
Read the loader to confirm whether it reads `.agents/skills/*/meta.yaml` + `references/criteria/*.md` directly (no build step) or requires a compile step. v2 compiles criteria markdown frontmatter into `CompiledField`s on load.

- [ ] **Step 2: Write a compile assertion script**

Create `scripts/assert-light-task.ts`:

```ts
import { loadCompiledTask } from "@chart-review/tasks";
const t = loadCompiledTask("lung-cancer-phenotype-light");
if (!t) throw new Error("task not found");
const ids = t.fields.map((f: any) => f.field_id).sort();
const expected = ["cancer_type", "disease_extent"];
if (JSON.stringify(ids) !== JSON.stringify(expected)) {
  throw new Error(`unexpected fields: ${ids.join(",")}`);
}
console.log("OK: lung-cancer-phenotype-light compiled with", ids.join(", "));
```

- [ ] **Step 3: Run it**

Run: `cd chart-review-platform-light && npx tsx scripts/assert-light-task.ts`
Expected: prints `OK: lung-cancer-phenotype-light compiled with cancer_type, disease_extent`. If the loader needs `schema_hash` populated, replace `REGENERATE` with the loader's computed hash (run whatever `criterion-hash` helper v2 uses, e.g. `packages/criterion-hash`) and re-run.

- [ ] **Step 4: Verify it appears in the task list**

Boot the server (`npm run dev`), then `curl -s http://localhost:3002/api/v2/tasks` and confirm `lung-cancer-phenotype-light` is listed with `task_kind: phenotype`. Stop the server.

- [ ] **Step 5: Commit**

```bash
cd <repo>
git add chart-review-platform-light/scripts/assert-light-task.ts chart-review-platform-light/.agents/skills/chart-review-lung-cancer-phenotype-light
git commit -m "test(light): assert cancer-type/extent task compiles with two fields

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task G3: End-to-end single-patient agent run (Azure)

**Files:**
- Modify: `.env` (set the deepagents + Azure vars)
- Test: manual e2e against one patient

- [ ] **Step 1: Configure `.env`**

Set (using the venv path recorded in Task C1 Step 3 and the Azure resource already documented in `.codex/config.toml`):

```
AGENT_PROVIDER=deepagents
DEEPAGENTS_PYTHON=/abs/path/chart-review-platform-light/python/.venv/bin/python
DEEPAGENTS_LLM_BACKEND=azure
AZURE_OPENAI_API_KEY=<from existing .env>
AZURE_OPENAI_ENDPOINT=https://iu-bhds-nlp-project.services.ai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-5.2
AZURE_OPENAI_API_VERSION=2024-10-21
MCP_TRANSPORT=subprocess
```

- [ ] **Step 2: Run TRY on one patient via the UI or run endpoint**

Boot `npm run dev`. In the UI: open `lung-cancer-phenotype-light` → TRY → select `patient_fake_cancer_08` → 1 agent → Start. Watch the agent log panel.
Expected: the agent calls `list_notes` / `read_notes` / `list_criteria` / `set_field_assessment` (visible in the live log), then completes.

- [ ] **Step 3: Verify `review_state.json` was written with both fields, faithfulness-clean**

Run: `cat var/runs/<latest>/per_patient/patient_fake_cancer_08/agents/agent_1.json` (or the scratch review_state path the run reports).
Expected: `field_assessments` contains `cancer_type` and `disease_extent`, each with `answer`, `confidence`, `evidence[].verbatim_quote`, `rationale`. No faithfulness rejection error in the log.

- [ ] **Step 4: Run with 2 agents to confirm the selector works**

Repeat Step 2 with 2 agents (`agent_1` default + `agent_2` skeptical). Expected: two per-agent drafts written; the VALIDATE pane later shows both with a disagreement flag where they differ.

- [ ] **Step 5: Commit env example (NOT the secret-bearing .env)**

Update `.env.example` with the new keys (no secrets), then:

```bash
cd <repo>
git add chart-review-platform-light/.env.example
git commit -m "docs(light): document deepagents + Azure/vLLM env vars

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase H — Validation + performance report

### Task H1: Verify the VALIDATE pane renders the two fields

**Files:** (no code change expected — data-driven from criteria)

- [ ] **Step 1: Validate one patient**

With the Task G3 run in place, open VALIDATE for `patient_fake_cancer_08`. Confirm: the note viewer shows the notes; each agent answer for `cancer_type` / `disease_extent` shows confidence + a clickable evidence quote that highlights the span; accept one and override the other with an edit reason.

- [ ] **Step 2: Confirm the human decision persists**

Run: `cat var/reviews/patient_fake_cancer_08/lung-cancer-phenotype-light/review_state.json`
Expected: the overridden field has `source: human` and the edit reason recorded.

- [ ] **Step 3:** If any NER/adherence-only widget errors in the pane, remove that dead branch, typecheck, and commit. Otherwise no commit.

### Task H2: Trim DECIDE to the performance report

**Files:**
- Modify: `client/src/ui/Workspace/PhaseDecide.tsx` (remove proposal-clustering + re-run UI; keep the per-agent leaderboard + confusion matrix)
- Modify: `client/src/ui/Workspace/ImprovementProposalsPanel.tsx` (delete) and its import
- Delete (server): `server/proposal-routes.ts` and its registration if proposals are removed

- [ ] **Step 1: Identify what DECIDE renders today**

Run: `grep -nE "Leaderboard|kappa|κ|confusion|proposal|Proposal|rerun|re-run|matchRate" client/src/ui/Workspace/PhaseDecide.tsx | head -30`
Identify the leaderboard/confusion section (keep) vs the improvement-proposal section (remove).

- [ ] **Step 2: Remove the proposal + re-run sections from `PhaseDecide.tsx`**

Delete the JSX + handlers for improvement proposals and one-click re-run. Keep the per-agent IAA leaderboard (match-rate + κ vs reviewer-validated answers) and confusion matrix. Remove the `ImprovementProposalsPanel` import.

- [ ] **Step 3: Delete the proposals panel + server route**

```bash
cd chart-review-platform-light
rm -f client/src/ui/Workspace/ImprovementProposalsPanel.tsx
rm -f server/proposal-routes.ts
```
Remove the `proposal-routes` import + registration from `server/index.ts`, and the `proposalRoutes` import in `Workspace/index.tsx`/`App.tsx` if present.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Fix any dangling proposal references the compiler names.

- [ ] **Step 5: Verify the report renders**

Boot the server, open DECIDE for the validated patient/cohort. Expected: per-agent match-rate + κ for `cancer_type` and `disease_extent`, plus a confusion matrix (agent vs human). No proposal/re-run UI.

- [ ] **Step 6: Commit**

```bash
cd <repo>
git add -A chart-review-platform-light/client chart-review-platform-light/server
git commit -m "feat(light): trim DECIDE to the performance report (leaderboard + confusion)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase I — Tests, e2e, docs, cleanup

### Task I1: Prune dead tests + add the sidecar test runner

**Files:**
- Delete: any vitest specs that target removed packages (NER/adherence/lock/deploy/judge/proposal)
- Modify: `python/pyproject.toml` (add `pytest` dev dep) or document the run command

- [ ] **Step 1: Find dead test files**

Run: `grep -rln "ner\|adherence\|span\|deploy\|lock-test\|proposal" --include='*.test.ts' --include='*.test.tsx' client packages | grep -v node_modules`
Delete the specs that exclusively test removed surfaces.

- [ ] **Step 2: Run the full TS suite**

Run: `cd chart-review-platform-light && npx vitest run --reporter=dot`
Expected: PASS, no references to deleted modules.

- [ ] **Step 3: Run the Python suite**

Run: `cd chart-review-platform-light/python && ./.venv/bin/python -m pytest -q`
Expected: PASS (models + events tests).

- [ ] **Step 4: Commit**

```bash
cd <repo>
git add -A chart-review-platform-light
git commit -m "test(light): prune tests for removed surfaces

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task I2: Trim Playwright e2e to run → validate → decide

**Files:**
- Modify: `e2e/` specs + `playwright.config.ts`

- [ ] **Step 1: Inventory e2e specs**

Run: `ls e2e && grep -rln "ner\|adherence\|lock\|deploy\|author\|judge" e2e`
Delete specs covering removed phases/kinds. Keep/author one spec: open `lung-cancer-phenotype-light`, run TRY (1 agent), validate one patient, view DECIDE.

- [ ] **Step 2: Run e2e**

Run: `npm run test:ui`
Expected: PASS (or the run-step skipped behind an env guard if it needs live Azure — gate the agent-run step with `test.skip(!process.env.AZURE_OPENAI_API_KEY)`).

- [ ] **Step 3: Commit**

```bash
cd <repo>
git add -A chart-review-platform-light/e2e chart-review-platform-light/playwright.config.ts
git commit -m "test(light): trim Playwright e2e to phenotype run→validate→decide

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task I3: README + CLAUDE.md for the light platform

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Rewrite README**

Replace the v2 README with a light version: one phenotype task (cancer-type/extent), notes-only, deepagents (Azure/vLLM) provider, the three-step pipeline, the Python sidecar setup (venv + `DEEPAGENTS_PYTHON`), and the run→validate→report quick start. Remove the three-task-kinds table and the OMOP/NER/adherence sections.

- [ ] **Step 2: Update CLAUDE.md seams table**

Update the **Agent invocation** seam to point at the deepagents provider + Python sidecar; remove NER/adherence/OMOP gotchas; update the phase list to TRY/VALIDATE/DECIDE.

- [ ] **Step 3: Final full verification**

Run: `cd chart-review-platform-light && npm run typecheck && npx vitest run --reporter=dot && (cd python && ./.venv/bin/python -m pytest -q)`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
cd <repo>
git add chart-review-platform-light/README.md chart-review-platform-light/CLAUDE.md
git commit -m "docs(light): README + CLAUDE.md for the light platform

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- `AGENT_PROVIDER=deepagents` is the only provider; claude/codex packages gone.
- Only the phenotype task kind remains; NER + adherence packages/panes/routes/tests removed.
- MCP server is notes-only (no `list_structured_data`/`read_structured_data`); no `corpus/*/omop/`.
- Phases are TRY → VALIDATE → DECIDE only.
- `lung-cancer-phenotype-light` compiles with fields `cancer_type` + `disease_extent` and runs end-to-end on Azure, writing faithfulness-clean `review_state.json`.
- VALIDATE renders both fields with evidence highlighting; DECIDE shows per-agent match-rate + κ + confusion matrix vs reviewer-validated answers.
- `npm run typecheck`, `npx vitest run`, and `pytest` all pass.
