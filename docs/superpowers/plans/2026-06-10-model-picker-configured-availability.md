# Model Picker Configured-Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A model appears in the session picker only when its backend is genuinely configured — env value set AND not the `.env.example` placeholder — instead of whenever an env var is merely non-empty.

**Architecture:** Two mirrored registry readers compute a per-model `available` flag: `server/lib/model-registry.ts` (feeds the UI picker) and `python/chart_review_deepagents/registry.py` (run-time resolution). Both currently treat "env var set" as available. We add a shared notion of "configured" = non-empty AND contains no known placeholder token, apply it in both `available` checks, and make the Python `resolve()` fail fast on a placeholder. The client already filters/gates on `available`, so no structural UI change — only a wording tweak.

**Tech Stack:** TypeScript (vitest), Python 3.11 (pytest), React.

---

### Task 1: TS registry — "configured, not placeholder" availability

**Files:**
- Modify: `server/lib/model-registry.ts:53-62`
- Test: `server/lib/model-registry.test.ts`

- [ ] **Step 1: Write the failing tests** — append inside the `describe("listModels", ...)` block in `server/lib/model-registry.test.ts`, before its closing `});`:

```ts
  it("marks vllm unavailable when base_url is the example placeholder", () => {
    const p = path.join(dir, "models.json");
    fs.writeFileSync(p, JSON.stringify({
      "qwen3-32b": { backend: "vllm", base_url_env: "VLLM_BASE_URL", model: "qwen3-32b", default: true },
    }));
    const env = { DEEPAGENTS_LLM_BACKEND: "vllm", VLLM_BASE_URL: "http://your-vllm-host:8000/v1" } as NodeJS.ProcessEnv;
    const { models, default: def } = listModels({ env, modelsPath: p });
    expect(models[0].available).toBe(false);
    expect(def).toBeNull();
  });

  it("marks vllm available when base_url is a real host", () => {
    const p = path.join(dir, "models.json");
    fs.writeFileSync(p, JSON.stringify({
      "qwen3-32b": { backend: "vllm", base_url_env: "VLLM_BASE_URL", model: "qwen3-32b", default: true },
    }));
    const env = { DEEPAGENTS_LLM_BACKEND: "vllm", VLLM_BASE_URL: "http://gpu1.hpc:8000/v1" } as NodeJS.ProcessEnv;
    const { models, default: def } = listModels({ env, modelsPath: p });
    expect(models[0].available).toBe(true);
    expect(def).toBe("qwen3-32b");
  });

  it("marks azure unavailable when endpoint is the example placeholder", () => {
    const env = {
      DEEPAGENTS_LLM_BACKEND: "azure", AZURE_OPENAI_DEPLOYMENT: "gpt-4o",
      AZURE_OPENAI_ENDPOINT: "https://YOUR-RESOURCE.openai.azure.com", AZURE_OPENAI_API_KEY: "secret",
    } as NodeJS.ProcessEnv;
    const { models } = listModels({ env, modelsPath: path.join(dir, "absent.json") });
    expect(models[0].available).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd nlp/chart-review-platform-concur && npx vitest run server/lib/model-registry.test.ts`
Expected: the 3 new tests FAIL (placeholder cases currently report `available: true`).

- [ ] **Step 3: Implement the "configured" rule** — in `server/lib/model-registry.ts`, replace the `available` function (lines 53-62) with:

```ts
// Tokens that appear ONLY in the .env.example / .env.docker.example placeholders.
// A value containing one of these is treated as not-yet-configured. Keep this
// list in sync with python/chart_review_deepagents/registry.py (_PLACEHOLDER_TOKENS).
const PLACEHOLDER_TOKENS = ["your-vllm-host", "your-resource"];

function isConfigured(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return !PLACEHOLDER_TOKENS.some((t) => lower.includes(t));
}

function available(entry: Entry, env: NodeJS.ProcessEnv): boolean {
  if (entry.backend === "azure") {
    const ep = env[entry.endpoint_env ?? "AZURE_OPENAI_ENDPOINT"];
    const key = env[entry.api_key_env ?? "AZURE_OPENAI_API_KEY"];
    return isConfigured(ep) && !!key;
  }
  // vllm: the base URL must be set AND not the example placeholder.
  const baseUrl = entry.base_url_env ? env[entry.base_url_env] : entry.base_url;
  return isConfigured(baseUrl);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd nlp/chart-review-platform-concur && npx vitest run server/lib/model-registry.test.ts`
Expected: PASS (all tests, including the pre-existing ones — their endpoints `https://x` / base_urls `http://h:8000/v1` contain no sentinel).

- [ ] **Step 5: Commit**

```bash
git add nlp/chart-review-platform-concur/server/lib/model-registry.ts nlp/chart-review-platform-concur/server/lib/model-registry.test.ts
git commit -m "fix(nlp): TS registry marks placeholder backends unavailable

A vLLM/Azure model is available only when its env value is set AND is not
the .env.example placeholder (your-vllm-host / YOUR-RESOURCE), so the UI
picker no longer offers a model that has not been wired up.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Python registry — mirror availability + fail fast in resolve()

**Files:**
- Modify: `python/chart_review_deepagents/registry.py:45-53` (`_available`) and `:106-114` (`resolve` vllm/azure branches)
- Test: `python/tests/test_registry.py`

- [ ] **Step 1: Write the failing tests** — append to `python/tests/test_registry.py`:

```python
def test_vllm_unavailable_when_base_url_is_placeholder(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({
        "qwen3-32b": {"backend": "vllm", "base_url_env": "VLLM_BASE_URL",
                      "model": "qwen3-32b", "default": True},
    }))
    env = {"DEEPAGENTS_LLM_BACKEND": "vllm", "VLLM_BASE_URL": "http://your-vllm-host:8000/v1"}
    models, default = registry.list_models(env=env, models_path=p)
    assert models[0]["available"] is False
    assert default is None


def test_vllm_available_when_base_url_is_real(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({
        "qwen3-32b": {"backend": "vllm", "base_url_env": "VLLM_BASE_URL",
                      "model": "qwen3-32b", "default": True},
    }))
    env = {"DEEPAGENTS_LLM_BACKEND": "vllm", "VLLM_BASE_URL": "http://gpu1.hpc:8000/v1"}
    models, default = registry.list_models(env=env, models_path=p)
    assert models[0]["available"] is True
    assert default == "qwen3-32b"


def test_resolve_raises_on_placeholder_base_url(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({
        "qwen3-32b": {"backend": "vllm", "base_url_env": "VLLM_BASE_URL", "model": "qwen3-32b"},
    }))
    env = {"VLLM_BASE_URL": "http://your-vllm-host:8000/v1"}
    with pytest.raises(ValueError, match="not configured"):
        registry.resolve("qwen3-32b", env=env, models_path=p)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd nlp/chart-review-platform-concur/python && ./.venv/bin/python -m pytest tests/test_registry.py -q`
Expected: the 3 new tests FAIL (placeholder currently reports available / resolves without error).
(If `.venv` is absent: `uv venv .venv --python 3.11 && uv pip install -e .` first, per CLAUDE.md.)

- [ ] **Step 3: Add the shared helper + use it in `_available`** — in `python/chart_review_deepagents/registry.py`, replace the `_available` function (lines 45-53) with:

```python
# Tokens that appear ONLY in the .env.example / .env.docker.example placeholders.
# A value containing one of these is treated as not-yet-configured. Keep in sync
# with server/lib/model-registry.ts (PLACEHOLDER_TOKENS).
#   your-vllm-host / YOUR-RESOURCE  -> .env.docker.example
#   <resource>                      -> .env.example (bare-metal) azure endpoint
_PLACEHOLDER_TOKENS = ("your-vllm-host", "your-resource", "<resource>")


def _is_configured(value):
    return bool(value) and not any(t in value.lower() for t in _PLACEHOLDER_TOKENS)


def _available(entry, env):
    if entry["backend"] == "azure":
        ep = env.get(entry.get("endpoint_env", "AZURE_OPENAI_ENDPOINT"))
        key = env.get(entry.get("api_key_env", "AZURE_OPENAI_API_KEY"))
        return _is_configured(ep) and bool(key)
    # vllm: the base URL must be set AND not the example placeholder.
    base_url = env.get(entry["base_url_env"]) if entry.get("base_url_env") else entry.get("base_url")
    return _is_configured(base_url)
```

- [ ] **Step 4: Make `resolve()` fail fast on a placeholder** — in `resolve()`, update the vllm branch. Replace:

```python
    base_url = env.get(entry["base_url_env"]) if entry.get("base_url_env") else entry.get("base_url")
    if not base_url:
        need = entry.get("base_url_env") or "base_url"
        raise ValueError(f"model {key!r} requires {need} but it is not set")
```

with:

```python
    base_url = env.get(entry["base_url_env"]) if entry.get("base_url_env") else entry.get("base_url")
    if not _is_configured(base_url):
        need = entry.get("base_url_env") or "base_url"
        raise ValueError(
            f"model {key!r} is not configured: set {need} to a real value "
            f"(not the .env.example placeholder)")
```

And in the azure branch of `resolve()`, drop a placeholder endpoint into the existing missing-var path by inserting this line immediately after `endpoint = env.get(ep_var)`:

```python
        if not _is_configured(endpoint):
            endpoint = None
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd nlp/chart-review-platform-concur/python && ./.venv/bin/python -m pytest tests/test_registry.py -q`
Expected: PASS (new + pre-existing tests; pre-existing endpoints/base_urls contain no sentinel).

- [ ] **Step 6: Commit**

```bash
git add nlp/chart-review-platform-concur/python/chart_review_deepagents/registry.py nlp/chart-review-platform-concur/python/tests/test_registry.py
git commit -m "fix(nlp): Python registry mirrors placeholder-availability + fails fast

_available() treats placeholder env values as not-configured (parity with
the TS reader); resolve() raises a clear 'not configured' error for a
placeholder base_url/endpoint instead of letting the run hit a DNS error.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: UI empty-state message mentions VLLM_BASE_URL

**Files:**
- Modify: `client/src/ui/PilotsTab/AgentConfigPanel.tsx:133-139`

- [ ] **Step 1: Update the `noModels` message** — replace the block at lines 133-139 with:

```tsx
        {noModels && (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11.5px] text-destructive">
            No model configured — set <span className="font-mono">VLLM_BASE_URL</span> to a real
            {" "}vLLM server, or <span className="font-mono">AZURE_OPENAI_*</span>, in
            {" "}<span className="font-mono">.env</span> and restart.
          </div>
        )}
```

- [ ] **Step 2: Typecheck**

Run: `cd nlp/chart-review-platform-concur && npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add nlp/chart-review-platform-concur/client/src/ui/PilotsTab/AgentConfigPanel.tsx
git commit -m "fix(nlp): empty-model message points at VLLM_BASE_URL too

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: End-to-end verification in the running app

**Files:** none (manual verification)

- [ ] **Step 1: Rebuild and restart the container**

Run: `cd nlp && docker compose up --build -d`
Expected: `chart-review` container `Up ... (healthy)`.

- [ ] **Step 2: Confirm the picker offers no model with the placeholder .env**

Run: `curl -fsS http://localhost:3002/api/deepagents/models`
Expected: every entry has `"available": false` and `"default": null` (the shipped `.env` still has `VLLM_BASE_URL=http://your-vllm-host:8000/v1`). In the UI, the session dialog shows "(no models available)" and **Create session** is disabled with the new message.

- [ ] **Step 3: Confirm a real backend makes the model appear** — temporarily point at any reachable OpenAI-compatible URL (no real server needed to prove availability flips):

Run:
```bash
cd nlp
sed -i '' 's#^VLLM_BASE_URL=.*#VLLM_BASE_URL=http://gpu1.hpc:8000/v1#' .env
docker compose up -d
curl -fsS http://localhost:3002/api/deepagents/models
```
Expected: the `qwen3-32b` entry now shows `"available": true` and `"default": "qwen3-32b"`.

- [ ] **Step 4: Restore the placeholder**

Run:
```bash
cd nlp
sed -i '' 's#^VLLM_BASE_URL=.*#VLLM_BASE_URL=http://your-vllm-host:8000/v1#' .env
docker compose up -d
```
Expected: back to no-models state. (`.env` is gitignored — nothing to commit.)

---

## Notes for the implementer

- `.env` is gitignored; do not commit it.
- The platform is vendored inside the IU repo; run all `git` commands from the IU repo root (paths above are repo-root-relative).
- Pre-existing tests intentionally use `https://x` (azure) and `http://h:8000/v1` (vllm), which contain no sentinel token, so they remain `available: true` after the change.
