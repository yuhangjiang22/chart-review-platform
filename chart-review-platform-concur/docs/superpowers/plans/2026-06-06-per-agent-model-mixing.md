# Per-Agent Model Mixing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each agent in a run use a different model, chosen in the UI from a registry of named models that each carry their own backend (Azure OpenAI or vLLM).

**Architecture:** A `models.json` registry (gitignored; `models.example.json` committed) declares named entries. Two thin readers parse it — Python (`registry.py`) for run-time model construction, TypeScript (`model-registry.ts`) for the `/api/deepagents/models` route. The UI dropdown's selected key flows `agent_specs[].model → runAgent({model}) → RunSpec.model → sidecar make_model(key)`. Each agent is its own subprocess, so two keys genuinely run two models. With no `models.json`, both readers synthesize one default entry from existing env, so current Azure-only setups are unchanged.

**Tech Stack:** Python 3.11 (langchain-openai, deepagents, pytest), TypeScript (Express route, Vitest), React 18 (Vitest + jsdom).

**Spec:** `docs/superpowers/specs/2026-06-06-per-agent-model-mixing-design.md`

---

## Registry contract (shared by both readers — implement identically)

A registry is `{ "<key>": Entry }`. `Entry` is one of:

```jsonc
// azure
{ "backend": "azure",
  "deployment": "gpt-4o",                       // required
  "endpoint_env": "AZURE_OPENAI_ENDPOINT",      // optional, this default
  "api_key_env": "AZURE_OPENAI_API_KEY",        // optional, this default
  "api_version_env": "AZURE_OPENAI_API_VERSION",// optional, this default
  "default": true }                             // optional
// vllm
{ "backend": "vllm",
  "base_url": "http://localhost:8000/v1",       // required
  "model": "meta-llama/Llama-3.3-70B-Instruct", // required
  "api_key_env": "VLLM_API_KEY",                // optional (→ "EMPTY" if unset/absent)
  "default": false }                            // optional
```

**Availability:** `azure` → `env[endpoint_env]` AND `env[api_key_env]` are both non-empty. `vllm` → always `true` (base_url is declared in the file).

**Default key:** the available entry whose `default === true`; else the first available entry (insertion order); else `null`.

**Label:** `azure` → `"azure · {deployment}"`; `vllm` → `"vllm · {model}"`.

**Synthesis (no `models.json`):** read `DEEPAGENTS_LLM_BACKEND` (default `"azure"`). For `azure`, synthesize one entry keyed by `env.AZURE_OPENAI_DEPLOYMENT` (or `"azure-default"` if unset) with the standard `*_env` names and `default: true`. For `vllm`, synthesize one entry keyed by `env.VLLM_MODEL` (or `"vllm-default"`) with `base_url=env.VLLM_BASE_URL`, `model=env.VLLM_MODEL`, `api_key_env="VLLM_API_KEY"`, `default: true`.

**File location (both readers):** `<platform_root>/python/models.json`. Python resolves it module-relative (`Path(__file__).resolve().parent.parent / "models.json"`). TS resolves it as `path.join(PLATFORM_ROOT, "python", "models.json")`.

---

## File Structure

- `python/chart_review_deepagents/registry.py` — **new.** Load/synthesize registry; `list_models(env)`, `resolve(key, env)`. Pure (env injected). Holds the Python copy of the contract.
- `python/chart_review_deepagents/models.py` — **modify.** `make_model(model_key=None)` builds the client from `resolve()`.
- `python/chart_review_deepagents/__main__.py` — **modify.** Pass `spec.get("model")` to `make_model`.
- `python/models.example.json` — **new, committed.** Template with one azure + one vllm entry.
- `python/tests/test_registry.py` — **new.** Registry loader/resolver tests.
- `python/tests/test_models.py` — **modify.** Add a `make_model(key)` routing test.
- `packages/agent-provider-deepagents/src/index.ts` — **modify.** Add `model?` to `RunSpec`; extract `buildRunSpec()` for testability.
- `packages/agent-provider-deepagents/src/build-run-spec.test.ts` — **new.** Unit test `buildRunSpec`.
- `server/lib/model-registry.ts` — **new.** TS reader: `listModels(opts?)` → `{ models, default }`. Presence-only (never reads secret values).
- `server/lib/model-registry.test.ts` — **new.** Loader tests.
- `server/misc-routes.ts` — **modify.** Replace `/api/deepagents/model` with `/api/deepagents/models`.
- `client/src/ui/PilotsTab/AgentConfigPanel.tsx` — **modify.** Per-agent `<select>` from the route; empty-state; `model` back on `AgentSpecForm`.
- `client/src/ui/Workspace/NewSessionDialog.tsx` — **modify.** Re-add `model` to `specsToApi`.
- `client/src/ui/Workspace/PhaseTry.tsx` — **modify.** Active-session view shows per-agent model; drop the singular-route fetch.
- `client/src/__tests__/AgentConfigPanel.models.test.tsx` — **new.** Dropdown + empty-state render.

---

### Task 1: Python registry loader

**Files:**
- Create: `python/chart_review_deepagents/registry.py`
- Test: `python/tests/test_registry.py`

- [ ] **Step 1: Write the failing test**

```python
# python/tests/test_registry.py
import json
import pytest
from chart_review_deepagents import registry


AZURE_ENV = {
    "AZURE_OPENAI_ENDPOINT": "https://x.openai.azure.com",
    "AZURE_OPENAI_API_KEY": "secret",
    "AZURE_OPENAI_DEPLOYMENT": "gpt-4o",
}


def test_synthesizes_azure_default_when_no_file(tmp_path):
    models, default = registry.list_models(env={**AZURE_ENV, "DEEPAGENTS_LLM_BACKEND": "azure"},
                                           models_path=tmp_path / "absent.json")
    assert default == "gpt-4o"
    assert models == [{"id": "gpt-4o", "backend": "azure",
                       "label": "azure · gpt-4o", "available": True}]


def test_azure_unavailable_when_key_missing(tmp_path):
    models, default = registry.list_models(
        env={"AZURE_OPENAI_ENDPOINT": "https://x", "AZURE_OPENAI_DEPLOYMENT": "gpt-4o",
             "DEEPAGENTS_LLM_BACKEND": "azure"},
        models_path=tmp_path / "absent.json")
    assert default is None
    assert models[0]["available"] is False


def test_reads_file_and_picks_marked_default(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({
        "gpt-4o": {"backend": "azure", "deployment": "gpt-4o"},
        "llama": {"backend": "vllm", "base_url": "http://h:8000/v1",
                  "model": "meta/Llama", "default": True},
    }))
    models, default = registry.list_models(env=AZURE_ENV, models_path=p)
    assert default == "llama"
    ids = {m["id"] for m in models}
    assert ids == {"gpt-4o", "llama"}
    assert next(m for m in models if m["id"] == "llama")["label"] == "vllm · meta/Llama"


def test_resolve_azure_reads_env_values(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"gpt-4o": {"backend": "azure", "deployment": "gpt-4o"}}))
    conn = registry.resolve("gpt-4o", env=AZURE_ENV, models_path=p)
    assert conn == {"backend": "azure", "azure_endpoint": "https://x.openai.azure.com",
                    "api_key": "secret", "api_version": "2024-10-21",
                    "azure_deployment": "gpt-4o"}


def test_resolve_vllm_defaults_api_key_empty(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"llama": {"backend": "vllm", "base_url": "http://h:8000/v1",
                                       "model": "meta/Llama"}}))
    conn = registry.resolve("llama", env={}, models_path=p)
    assert conn == {"backend": "vllm", "base_url": "http://h:8000/v1",
                    "api_key": "EMPTY", "model": "meta/Llama"}


def test_resolve_unknown_key_raises(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"gpt-4o": {"backend": "azure", "deployment": "gpt-4o"}}))
    with pytest.raises(ValueError, match="unknown model"):
        registry.resolve("nope", env=AZURE_ENV, models_path=p)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && ./.venv/bin/python -m pytest tests/test_registry.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'chart_review_deepagents.registry'`

- [ ] **Step 3: Write the implementation**

```python
# python/chart_review_deepagents/registry.py
"""Model registry: declares named models (Azure/vLLM) selectable per agent.

Reads <platform_root>/python/models.json. When that file is absent, synthesizes
a single default entry from the existing env vars so current setups keep working
with no new file. This module is the Python copy of the registry contract; the
TypeScript copy is server/lib/model-registry.ts — keep the two in sync (see the
spec for the canonical contract)."""
import json
import os
from pathlib import Path

_DEFAULT_MODELS_PATH = Path(__file__).resolve().parent.parent / "models.json"


def _load_raw(models_path):
    path = Path(models_path) if models_path is not None else _DEFAULT_MODELS_PATH
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def _synthesize(env):
    backend = env.get("DEEPAGENTS_LLM_BACKEND", "azure").lower()
    if backend == "vllm":
        key = env.get("VLLM_MODEL") or "vllm-default"
        return {key: {"backend": "vllm",
                      "base_url": env.get("VLLM_BASE_URL", ""),
                      "model": env.get("VLLM_MODEL", ""),
                      "api_key_env": "VLLM_API_KEY", "default": True}}
    key = env.get("AZURE_OPENAI_DEPLOYMENT") or "azure-default"
    return {key: {"backend": "azure", "deployment": env.get("AZURE_OPENAI_DEPLOYMENT", ""),
                  "default": True}}


def _entries(env, models_path):
    raw = _load_raw(models_path)
    return raw if raw is not None else _synthesize(env)


def _available(entry, env):
    if entry["backend"] == "azure":
        ep = env.get(entry.get("endpoint_env", "AZURE_OPENAI_ENDPOINT"))
        key = env.get(entry.get("api_key_env", "AZURE_OPENAI_API_KEY"))
        return bool(ep) and bool(key)
    return True  # vllm: declared == available; reachability is a run-time concern


def _label(entry):
    if entry["backend"] == "azure":
        return f"azure · {entry['deployment']}"
    return f"vllm · {entry['model']}"


def list_models(env=None, models_path=None):
    """Return (models, default_key). models is a list of presence-only dicts
    {id, backend, label, available} in insertion order. default_key is the
    available entry marked default, else the first available, else None."""
    env = os.environ if env is None else env
    entries = _entries(env, models_path)
    models, default = [], None
    for key, entry in entries.items():
        avail = _available(entry, env)
        models.append({"id": key, "backend": entry["backend"],
                       "label": _label(entry), "available": avail})
        if avail and default is None:
            default = key
    marked = next((k for k, e in entries.items()
                   if e.get("default") and _available(e, env)), None)
    if marked is not None:
        default = marked
    return models, default


def resolve(key, env=None, models_path=None):
    """Return a connection dict for make_model(). Reads secret VALUES from env
    (Python side only). Raises ValueError on an unknown key."""
    env = os.environ if env is None else env
    entries = _entries(env, models_path)
    entry = entries.get(key)
    if entry is None:
        raise ValueError(f"unknown model {key!r} (not in registry)")
    if entry["backend"] == "azure":
        return {"backend": "azure",
                "azure_endpoint": env[entry.get("endpoint_env", "AZURE_OPENAI_ENDPOINT")],
                "api_key": env[entry.get("api_key_env", "AZURE_OPENAI_API_KEY")],
                "api_version": env.get(entry.get("api_version_env", "AZURE_OPENAI_API_VERSION"),
                                       "2024-10-21"),
                "azure_deployment": entry["deployment"]}
    return {"backend": "vllm",
            "base_url": entry["base_url"],
            "api_key": env.get(entry.get("api_key_env", "VLLM_API_KEY"), "EMPTY") or "EMPTY",
            "model": entry["model"]}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && ./.venv/bin/python -m pytest tests/test_registry.py -q`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add python/chart_review_deepagents/registry.py python/tests/test_registry.py
git commit -m "feat(light): model registry loader for per-agent model selection"
```

---

### Task 2: `make_model(model_key)` resolves via the registry

**Files:**
- Modify: `python/chart_review_deepagents/models.py`
- Modify: `python/chart_review_deepagents/__main__.py:48`
- Test: `python/tests/test_models.py`

- [ ] **Step 1: Write the failing test** (append to `python/tests/test_models.py`)

```python
def test_make_model_resolves_registry_key(monkeypatch, tmp_path):
    import json
    from chart_review_deepagents import models as models_mod
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"llama": {"backend": "vllm", "base_url": "http://h:8000/v1",
                                       "model": "meta/Llama"}}))
    monkeypatch.setattr("chart_review_deepagents.registry._DEFAULT_MODELS_PATH", p)
    captured = {}

    class FakeChat:
        def __init__(self, **kw):
            captured.update(kw)

    monkeypatch.setattr("langchain_openai.ChatOpenAI", FakeChat)
    models_mod.make_model("llama")
    assert captured["base_url"] == "http://h:8000/v1"
    assert captured["model"] == "meta/Llama"
    assert captured["api_key"] == "EMPTY"


def test_make_model_unknown_key_raises(monkeypatch, tmp_path):
    import json
    from chart_review_deepagents import models as models_mod
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"llama": {"backend": "vllm", "base_url": "http://h:8000/v1",
                                       "model": "meta/Llama"}}))
    monkeypatch.setattr("chart_review_deepagents.registry._DEFAULT_MODELS_PATH", p)
    with pytest.raises(ValueError, match="unknown model"):
        models_mod.make_model("nope")
```

Also **replace** the two existing tests (`test_unknown_backend_raises`, `test_vllm_requires_base_url`) — they assumed env-only `make_model()`. Replace with:

```python
def test_make_model_default_key_uses_synthesized_entry(monkeypatch, tmp_path):
    import json
    from chart_review_deepagents import models as models_mod
    # absent file → synthesize from env (azure)
    monkeypatch.setattr("chart_review_deepagents.registry._DEFAULT_MODELS_PATH",
                        tmp_path / "absent.json")
    monkeypatch.setenv("DEEPAGENTS_LLM_BACKEND", "azure")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://x")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "secret")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
    captured = {}

    class FakeAzure:
        def __init__(self, **kw):
            captured.update(kw)

    monkeypatch.setattr("langchain_openai.AzureChatOpenAI", FakeAzure)
    models_mod.make_model()  # no key → default
    assert captured["azure_deployment"] == "gpt-4o"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && ./.venv/bin/python -m pytest tests/test_models.py -q`
Expected: FAIL — `make_model()` takes no arguments / does not consult the registry.

- [ ] **Step 3: Rewrite `models.py`**

```python
# chart_review_deepagents/models.py
from . import registry


def make_model(model_key=None):
    """Build a LangChain chat model for a registry key. When model_key is None,
    use the registry's default entry. The registry resolves the key to a
    backend + connection (Azure or vLLM); see registry.py for the contract."""
    if model_key is None:
        _, model_key = registry.list_models()
        if model_key is None:
            raise ValueError(
                "no model available — set AZURE_OPENAI_* in .env, or start a "
                "vLLM server and add it to python/models.json")
    conn = registry.resolve(model_key)
    if conn["backend"] == "azure":
        from langchain_openai import AzureChatOpenAI

        return AzureChatOpenAI(
            azure_endpoint=conn["azure_endpoint"],
            api_key=conn["api_key"],
            api_version=conn["api_version"],
            azure_deployment=conn["azure_deployment"],
            temperature=0,
        )
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        base_url=conn["base_url"],
        api_key=conn["api_key"],
        model=conn["model"],
        temperature=0,
    )
```

- [ ] **Step 4: Thread the key from the run spec** — edit `__main__.py:48`

Change:
```python
            model=make_model(),
```
to:
```python
            model=make_model(spec.get("model")),
```

Also update the run-spec docstring at the top of `__main__.py` (lines 4-6) to add `"model": str | None` to the documented shape:
```python
#   { "prompt": str, "system_prompt": str, "max_turns": int, "model": str|None,
#     "mcp": { "command": str, "args": [str], "env": {str:str}, "type": "stdio" } }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd python && ./.venv/bin/python -m pytest tests/test_models.py tests/test_registry.py -q`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add python/chart_review_deepagents/models.py python/chart_review_deepagents/__main__.py python/tests/test_models.py
git commit -m "feat(light): make_model(key) resolves through the model registry"
```

---

### Task 3: Committed template + gitignore

**Files:**
- Create: `python/models.example.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write the template**

```jsonc
// python/models.example.json
// Copy to python/models.json and edit. Keys are the model ids shown in the UI.
// Secrets are referenced by ENV VAR NAME (api_key_env), never inlined here.
// Azure entries need their endpoint+key env vars set to be "available".
// vLLM entries are always available once declared (start the server separately).
{
  "gpt-4o": {
    "backend": "azure",
    "deployment": "gpt-4o",
    "endpoint_env": "AZURE_OPENAI_ENDPOINT",
    "api_key_env": "AZURE_OPENAI_API_KEY",
    "api_version_env": "AZURE_OPENAI_API_VERSION",
    "default": true
  },
  "llama-3.3-70b": {
    "backend": "vllm",
    "base_url": "http://localhost:8000/v1",
    "model": "meta-llama/Llama-3.3-70B-Instruct"
  }
}
```

> Note: `models.example.json` is committed; JSON has no comment syntax, so when writing the file strip the `//` lines (keep them only in this plan for explanation). Write valid JSON: open with `{` directly.

- [ ] **Step 2: Add models.json to .gitignore**

Append to `.gitignore`:
```
# Per-deployment model registry (copy from python/models.example.json)
/python/models.json
```

- [ ] **Step 3: Verify ignore works**

Run: `printf '{}' > python/models.json && git status --porcelain python/models.json`
Expected: no output (file is ignored). Then: `rm python/models.json`

- [ ] **Step 4: Commit**

```bash
git add python/models.example.json .gitignore
git commit -m "feat(light): committed model-registry template + gitignore models.json"
```

---

### Task 4: Provider forwards the model into the run spec

**Files:**
- Modify: `packages/agent-provider-deepagents/src/index.ts:26-49`
- Test: `packages/agent-provider-deepagents/src/build-run-spec.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-provider-deepagents/src/build-run-spec.test.ts
import { describe, it, expect } from "vitest";
import { buildRunSpec } from "./index.js";

const base = {
  prompt: "hi",
  mcpServers: { chart_review_state: { command: "x", args: [], env: {} } },
} as any;

describe("buildRunSpec", () => {
  it("includes model when input.model is set", () => {
    const spec = buildRunSpec({ ...base, model: "llama-3.3-70b" });
    expect(spec.model).toBe("llama-3.3-70b");
  });
  it("omits model when input.model is absent", () => {
    const spec = buildRunSpec(base);
    expect(spec.model).toBeUndefined();
  });
  it("carries prompt, system prompt, max_turns, mcp", () => {
    const spec = buildRunSpec({ ...base, extraSystemPrompt: "sys", maxTurns: 12 });
    expect(spec.prompt).toBe("hi");
    expect(spec.system_prompt).toBe("sys");
    expect(spec.max_turns).toBe(12);
    expect(spec.mcp).toEqual(base.mcpServers.chart_review_state);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent-provider-deepagents/src/build-run-spec.test.ts`
Expected: FAIL — `buildRunSpec` is not exported.

- [ ] **Step 3: Add `model` to `RunSpec` and extract `buildRunSpec`**

In `packages/agent-provider-deepagents/src/index.ts`, change the `RunSpec` interface (lines 26-31):
```ts
interface RunSpec {
  prompt: string;
  system_prompt: string;
  max_turns: number;
  /** Registry key for the model this agent runs on. Resolved by the Python
   *  sidecar via registry.resolve(); undefined → the registry default. */
  model?: string;
  mcp: unknown; // the chart_review_state stdio config {type,command,args,env}
}
```

Add an exported builder above the class (after line 33's `KNOWN_EVENT_TYPES`):
```ts
/** Build the JSON run spec handed to the Python sidecar. Exported so the
 *  prompt → spec mapping (including the per-agent model) is unit-testable
 *  without spawning a subprocess. Returns null when no MCP config is present. */
export function buildRunSpec(input: AgentRunInput): RunSpec | null {
  const mcp = (input.mcpServers as Record<string, unknown> | undefined)?.chart_review_state;
  if (!mcp) return null;
  const spec: RunSpec = {
    prompt: input.prompt,
    system_prompt: input.extraSystemPrompt ?? "",
    max_turns: input.maxTurns ?? 60,
    mcp,
  };
  if (input.model) spec.model = input.model;
  return spec;
}
```

Replace the inline spec construction in `run()` (lines 37-47) with:
```ts
    const spec = buildRunSpec(input);
    if (!spec) {
      yield { type: "error", error: "deepagents provider: no chart_review_state MCP config in mcpServers" };
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent-provider-deepagents/src/build-run-spec.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-provider-deepagents/src/index.ts packages/agent-provider-deepagents/src/build-run-spec.test.ts
git commit -m "feat(light): forward per-agent model into the deepagents run spec"
```

---

### Task 5: TypeScript registry reader

**Files:**
- Create: `server/lib/model-registry.ts`
- Test: `server/lib/model-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/model-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listModels } from "./model-registry.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const AZURE_ENV = {
  AZURE_OPENAI_ENDPOINT: "https://x", AZURE_OPENAI_API_KEY: "secret",
  AZURE_OPENAI_DEPLOYMENT: "gpt-4o", DEEPAGENTS_LLM_BACKEND: "azure",
} as NodeJS.ProcessEnv;

describe("listModels", () => {
  it("synthesizes azure default when no file", () => {
    const { models, default: def } = listModels({ env: AZURE_ENV, modelsPath: path.join(dir, "absent.json") });
    expect(def).toBe("gpt-4o");
    expect(models).toEqual([{ id: "gpt-4o", backend: "azure", label: "azure · gpt-4o", available: true }]);
  });

  it("marks azure unavailable when key missing", () => {
    const env = { AZURE_OPENAI_ENDPOINT: "https://x", AZURE_OPENAI_DEPLOYMENT: "gpt-4o", DEEPAGENTS_LLM_BACKEND: "azure" } as NodeJS.ProcessEnv;
    const { models, default: def } = listModels({ env, modelsPath: path.join(dir, "absent.json") });
    expect(def).toBeNull();
    expect(models[0].available).toBe(false);
  });

  it("reads file and picks marked default; never leaks secrets", () => {
    const p = path.join(dir, "models.json");
    fs.writeFileSync(p, JSON.stringify({
      "gpt-4o": { backend: "azure", deployment: "gpt-4o" },
      "llama": { backend: "vllm", base_url: "http://h:8000/v1", model: "meta/Llama", default: true },
    }));
    const { models, default: def } = listModels({ env: AZURE_ENV, modelsPath: p });
    expect(def).toBe("llama");
    expect(JSON.stringify(models)).not.toContain("secret");
    expect(models.find((m) => m.id === "llama")!.label).toBe("vllm · meta/Llama");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/lib/model-registry.test.ts`
Expected: FAIL — cannot find module `./model-registry.js`.

- [ ] **Step 3: Write the reader** (presence-only — mirrors `registry.py`, never reads secret values)

```ts
// server/lib/model-registry.ts
// TypeScript reader for the model registry (python/models.json). Mirrors the
// Python copy (python/chart_review_deepagents/registry.py) — keep the contract
// in sync (see docs/superpowers/specs/2026-06-06-per-agent-model-mixing-design.md).
// This reader is PRESENCE-ONLY: it checks whether secret env vars are SET to
// compute availability, but never returns their values.
import fs from "node:fs";
import path from "node:path";

const PLATFORM_ROOT = process.env.CHART_REVIEW_PLATFORM_ROOT ?? process.cwd();
const DEFAULT_MODELS_PATH = path.join(PLATFORM_ROOT, "python", "models.json");

interface AzureEntry {
  backend: "azure"; deployment: string;
  endpoint_env?: string; api_key_env?: string; api_version_env?: string; default?: boolean;
}
interface VllmEntry {
  backend: "vllm"; base_url: string; model: string; api_key_env?: string; default?: boolean;
}
type Entry = AzureEntry | VllmEntry;
type Registry = Record<string, Entry>;

export interface ModelInfo { id: string; backend: "azure" | "vllm"; label: string; available: boolean; }
export interface ListModelsResult { models: ModelInfo[]; default: string | null; }

function synthesize(env: NodeJS.ProcessEnv): Registry {
  const backend = (env.DEEPAGENTS_LLM_BACKEND ?? "azure").toLowerCase();
  if (backend === "vllm") {
    const key = env.VLLM_MODEL || "vllm-default";
    return { [key]: { backend: "vllm", base_url: env.VLLM_BASE_URL ?? "", model: env.VLLM_MODEL ?? "", api_key_env: "VLLM_API_KEY", default: true } };
  }
  const key = env.AZURE_OPENAI_DEPLOYMENT || "azure-default";
  return { [key]: { backend: "azure", deployment: env.AZURE_OPENAI_DEPLOYMENT ?? "", default: true } };
}

function loadRegistry(env: NodeJS.ProcessEnv, modelsPath: string): Registry {
  try {
    if (fs.existsSync(modelsPath)) return JSON.parse(fs.readFileSync(modelsPath, "utf8")) as Registry;
  } catch { /* malformed → fall through to synthesis */ }
  return synthesize(env);
}

function available(entry: Entry, env: NodeJS.ProcessEnv): boolean {
  if (entry.backend === "azure") {
    const ep = env[entry.endpoint_env ?? "AZURE_OPENAI_ENDPOINT"];
    const key = env[entry.api_key_env ?? "AZURE_OPENAI_API_KEY"];
    return !!ep && !!key;
  }
  return true;
}

function label(entry: Entry): string {
  return entry.backend === "azure" ? `azure · ${entry.deployment}` : `vllm · ${entry.model}`;
}

export function listModels(opts?: { env?: NodeJS.ProcessEnv; modelsPath?: string }): ListModelsResult {
  const env = opts?.env ?? process.env;
  const modelsPath = opts?.modelsPath ?? DEFAULT_MODELS_PATH;
  const registry = loadRegistry(env, modelsPath);
  const models: ModelInfo[] = [];
  let def: string | null = null;
  for (const [id, entry] of Object.entries(registry)) {
    const avail = available(entry, env);
    models.push({ id, backend: entry.backend, label: label(entry), available: avail });
    if (avail && def === null) def = id;
  }
  const marked = Object.entries(registry).find(([, e]) => e.default && available(e, env));
  if (marked) def = marked[0];
  return { models, default: def };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/lib/model-registry.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add server/lib/model-registry.ts server/lib/model-registry.test.ts
git commit -m "feat(light): TypeScript model-registry reader (presence-only)"
```

---

### Task 6: Replace the route with `/api/deepagents/models`

**Files:**
- Modify: `server/misc-routes.ts` (the `/api/deepagents/model` block added earlier)

- [ ] **Step 1: Replace the route**

In `server/misc-routes.ts`, add the import near the top (after the `model-config.js` import block):
```ts
import { listModels } from "./lib/model-registry.js";
```

Replace the entire `/api/deepagents/model` route block (the handler that reads `DEEPAGENTS_LLM_BACKEND` + `AZURE_OPENAI_DEPLOYMENT`/`VLLM_MODEL`) with:
```ts
  // ── /api/deepagents/models ──────────────────────────────────────────
  //
  // The models every agent can run on, with availability. The deepagents
  // sidecar resolves a per-agent model key through the same registry
  // (python/chart_review_deepagents/registry.py); this route is the
  // presence-only reader for the UI picker — it returns labels +
  // availability + the default key, never any secret value.
  {
    method: "GET", pattern: "/api/deepagents/models",
    handler: async () => listModels(),
  },
```

- [ ] **Step 2: Typecheck + smoke the route**

Run: `npm run typecheck`
Expected: no errors.

Run (server must be up; otherwise skip): `curl -s http://localhost:3002/api/deepagents/models`
Expected: JSON `{"models":[{"id":"gpt-4o","backend":"azure","label":"azure · gpt-4o","available":true}],"default":"gpt-4o"}` for the current Azure-only `.env`.

- [ ] **Step 3: Commit**

```bash
git add server/misc-routes.ts
git commit -m "feat(light): GET /api/deepagents/models replaces singular model route"
```

---

### Task 7: Per-agent model dropdown in AgentConfigPanel

**Files:**
- Modify: `client/src/ui/PilotsTab/AgentConfigPanel.tsx`
- Test: `client/src/__tests__/AgentConfigPanel.models.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// client/src/__tests__/AgentConfigPanel.models.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentConfigPanel } from "../ui/PilotsTab/AgentConfigPanel";

vi.mock("../auth", () => ({
  authFetch: vi.fn((url: string) => {
    if (url === "/api/agent-roles") return Promise.resolve({ ok: true, json: () => Promise.resolve({ presets: [] }) });
    if (url === "/api/deepagents/models") return Promise.resolve({ ok: true, json: () => Promise.resolve({
      models: [
        { id: "gpt-4o", backend: "azure", label: "azure · gpt-4o", available: true },
        { id: "llama", backend: "vllm", label: "vllm · meta/Llama", available: true },
      ], default: "gpt-4o",
    }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  }),
}));

const specs = [{ id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" }];

describe("AgentConfigPanel model picker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders a model dropdown with the registry options", async () => {
    render(<AgentConfigPanel value={specs} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("vllm · meta/Llama")).toBeInTheDocument());
    expect(screen.getByText("azure · gpt-4o")).toBeInTheDocument();
  });
});

describe("AgentConfigPanel empty state", () => {
  it("shows a configure message when no models are available", async () => {
    const { authFetch } = await import("../auth");
    (authFetch as any).mockImplementation((url: string) =>
      url === "/api/deepagents/models"
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [], default: null }) })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ presets: [] }) }));
    render(<AgentConfigPanel value={specs} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No model configured/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/__tests__/AgentConfigPanel.models.test.tsx`
Expected: FAIL — no dropdown / no "No model configured" text (panel currently renders a read-only badge).

- [ ] **Step 3: Update `AgentConfigPanel.tsx`**

Re-add `model` to the form type (top of file):
```ts
export interface AgentSpecForm {
  id: string;
  search_mode_preset?: string;
  interpretation_preset?: string;
  role_prompt?: string;
  /** Registry key from /api/deepagents/models. Undefined → the registry
   *  default (the sidecar resolves it). */
  model?: string;
}
```

Replace the `runtimeModel` state + its `useEffect` (the block fetching `/api/deepagents/model`) with the plural fetch:
```ts
  interface ModelInfo { id: string; backend: string; label: string; available: boolean; }
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  useEffect(() => {
    authFetch("/api/deepagents/models")
      .then((r) => (r.ok ? r.json() : { models: [], default: null }))
      .then((d) => {
        setModels(Array.isArray(d.models) ? d.models : []);
        setDefaultModelId(typeof d.default === "string" ? d.default : null);
      })
      .catch(() => { setModels([]); setDefaultModelId(null); })
      .finally(() => setModelsLoaded(true));
  }, []);

  const availableModels = useMemo(() => models.filter((m) => m.available), [models]);
  const noModels = modelsLoaded && availableModels.length === 0;
```

Replace the header model **badge** block (the `<div className="mt-2 flex items-center gap-1.5 ...">` that shows `runtimeModel`) with the empty-state notice:
```tsx
        {noModels && (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11.5px] text-destructive">
            No model configured — set <span className="font-mono">AZURE_OPENAI_*</span> in
            {" "}<span className="font-mono">.env</span>, or start a vLLM server and add it to
            {" "}<span className="font-mono">python/models.json</span>.
          </div>
        )}
```

Add the per-agent `<select>` inside the agent card, right after the `isCustom ? … : ( … )` axis block closes (i.e. after the axis `</div>` and before the card's closing `</div>`):
```tsx
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Model
                  <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">
                    — which model this agent runs on
                  </span>
                </span>
                <select
                  value={spec.model ?? defaultModelId ?? ""}
                  onChange={(e) => updateSpec(i, { model: e.target.value || undefined })}
                  disabled={availableModels.length === 0}
                  className="rounded-md border border-border px-2 py-1 text-[12px] font-mono bg-background"
                >
                  {availableModels.length === 0 && <option value="">(no models available)</option>}
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </label>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/__tests__/AgentConfigPanel.models.test.tsx`
Expected: PASS (2 passed)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/ui/PilotsTab/AgentConfigPanel.tsx client/src/__tests__/AgentConfigPanel.models.test.tsx
git commit -m "feat(light): per-agent model dropdown backed by the registry"
```

---

### Task 8: Send the model in the new-session payload + show it in TRY

**Files:**
- Modify: `client/src/ui/Workspace/NewSessionDialog.tsx:38-47`
- Modify: `client/src/ui/Workspace/PhaseTry.tsx`

- [ ] **Step 1: Re-add `model` to `specsToApi`** in `NewSessionDialog.tsx`

Replace the comment line added earlier:
```ts
    if (s.role_prompt) out.role_prompt = s.role_prompt;
    // No per-agent model: the deepagents sidecar resolves one model from env.
    return out;
```
with:
```ts
    if (s.role_prompt) out.role_prompt = s.role_prompt;
    if (s.model) out.model = s.model; // registry key; undefined → sidecar default
    return out;
```

- [ ] **Step 2: Show the selected model in the active-session view** in `PhaseTry.tsx`

The active-session read-only list (the `sessionAgentSpecs.map((s) => …)` block) currently shows only `search_mode_preset` and `interpretation_preset`. Add the model:
```tsx
              const parts = [
                s.search_mode_preset,
                s.interpretation_preset,
                s.model,
              ].filter(Boolean);
```
(`AgentSpecForm` now has `model?` again from Task 7, so this typechecks. When `model` is undefined — old sessions, or "use default" — it's simply omitted from the line, and the run uses the registry default.)

- [ ] **Step 3: Remove the now-redundant singular-route fetch in `PhaseTry.tsx`**

`PhaseTry.tsx` fetched `/api/deepagents/model` (singular) to build `modelSuffix` for `runtimeLabel`. That route no longer exists. Remove the `runtimeModel` state, its `authFetch("/api/deepagents/model")` effect, and the `modelSuffix` constant; restore `runtimeLabel` to:
```tsx
  const runtimeLabel = agentProvider === "deepagents"
    ? "deepagents (Python sidecar · tool-using agent loop)"
    : agentProvider
      ? `agent runtime: ${agentProvider}`
      : "agent runtime: (loading…)";
```
(The per-agent model now appears per-agent in the list, so the runtime line no longer needs a model suffix.)

- [ ] **Step 4: Typecheck + run the full client test suite**

Run: `npm run typecheck`
Expected: no errors (confirms no other reference to the removed singular route / `modelSuffix`).

Run: `npx vitest run --reporter=dot`
Expected: all tests pass (116 prior + the new AgentConfigPanel tests + buildRunSpec + model-registry).

- [ ] **Step 5: Commit**

```bash
git add client/src/ui/Workspace/NewSessionDialog.tsx client/src/ui/Workspace/PhaseTry.tsx
git commit -m "feat(light): send per-agent model key + surface it in TRY"
```

---

### Task 9: Full-stack verification

**Files:** none (verification only)

- [ ] **Step 1: All gates green**

```bash
npm run typecheck && npm run build:client && npx vitest run --reporter=dot
cd python && ./.venv/bin/python -m pytest -q && cd ..
```
Expected: typecheck 0 errors; client builds; all vitest pass; all pytest pass.

- [ ] **Step 2: Live route check**

With the dev server running (`npm run dev`):
```bash
curl -s http://localhost:3002/api/deepagents/models
```
Expected (current Azure-only `.env`, no `models.json`): `{"models":[{"id":"gpt-4o","backend":"azure","label":"azure · gpt-4o","available":true}],"default":"gpt-4o"}`

- [ ] **Step 3: Mixing dry-run with a fixture registry (Azure-only machine)**

Create a temporary `python/models.json` with two Azure entries pointing at the same deployment under different keys, to prove the key threads end-to-end without needing vLLM:
```bash
cat > python/models.json <<'JSON'
{
  "gpt-4o":   { "backend": "azure", "deployment": "gpt-4o", "default": true },
  "gpt-4o-b": { "backend": "azure", "deployment": "gpt-4o" }
}
JSON
curl -s http://localhost:3002/api/deepagents/models
```
Expected: both `gpt-4o` and `gpt-4o-b` listed, `available: true`, default `gpt-4o`. In the UI's New Session dialog, agent_1 and agent_2 can now select different keys. Remove the fixture when done: `rm python/models.json`.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A && git commit -m "chore(light): verify per-agent model mixing end-to-end"
```

---

## Notes for the implementer

- **Run from** `chart-review-platform-light/` for all `npm`/`npx`/`curl` commands; from `chart-review-platform-light/python/` for the venv pytest invocation (`./.venv/bin/python -m pytest`).
- **Duplicated contract:** `registry.py` and `model-registry.ts` deliberately re-implement the same availability/label/synthesis rules in two languages (no IPC between them). If you change the contract in one, change the other — the spec is the source of truth.
- **No secrets in `models.json` or any payload.** The TS reader checks env-var *presence*; only the Python `resolve()` reads secret *values*, and those never leave the sidecar process.
- **Back-compat:** with no `models.json`, behavior is identical to today (one synthesized Azure entry). Old sessions whose `agent_specs` have no `model` resolve to the registry default.
