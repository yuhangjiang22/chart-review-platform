# Per-Agent Model Mixing — Design

**Date:** 2026-06-06
**Status:** Approved (pending implementation plan)
**Scope:** chart-review-platform-light

## Goal

Let each agent in a run use a different model, chosen in the UI from a registry
of named models that each carry their own backend (Azure OpenAI or vLLM) and
connection details. The picker shows only models that are actually configured
for this deployment; if none are, it tells the user to configure Azure or start
a vLLM server. Testable now against Azure, vLLM-ready with no code change.

## Motivation

The deepagents sidecar resolves a single model from env and ignores any
per-agent value, even though the orchestration layer already runs each agent as
its own subprocess and already threads `spec.model` into `runAgent()`
(`packages/infra-batch-run/src/runs.ts:763`). The wire is ~60% there; what's
missing is (a) the provider forwarding the model, (b) the sidecar resolving it,
and (c) an honest UI picker backed by real models. A previous change removed a
*fake* per-agent picker (hardcoded claude/deepseek chips the sidecar ignored)
and replaced it with a read-only badge; this feature restores per-agent
selection in its honest, working form.

## Non-goals

- Live reachability probing of vLLM endpoints (greying out unreachable models).
  Deferred — the registry is pure declaration; reachability is a runtime concern
  surfaced as a run-time error.
- Managing the vLLM server lifecycle. vLLM is an external OpenAI-compatible
  service the user starts out of band; the app only connects to it as a client.
- Per-field or per-patient model selection. Selection is per agent.

## Architecture

```
UI dropdown (registry key)
  -> agent_specs[].model                         (client → server, restored)
  -> runAgent({ model: spec.model })             (already wired, runs.ts:763)
  -> deepagents RunSpec.model                    (NEW: provider forwards it)
  -> sidecar make_model(key)                     (NEW: registry lookup → client)
  -> LangChain chat model (Azure or vLLM)
```

Each agent is its own subprocess, so two agents with two keys genuinely run on
two models. No shared-process coordination required.

## Components

### 1. Model registry

- **`python/models.json`** — gitignored, per-deployment. Declares named entries.
- **`python/models.example.json`** — committed template (mirrors the
  `.env`/`.env.example` convention so per-user infra like vLLM URLs is not
  committed).
- Secret-free: API keys are referenced by **env var name**, never inline. vLLM
  entries omit `api_key_env` and fall back to the OpenAI client's required
  placeholder `"EMPTY"`.

Entry shape:

```jsonc
{
  "gpt-4o": {
    "backend": "azure",
    "deployment": "gpt-4o",
    "endpoint_env": "AZURE_OPENAI_ENDPOINT",
    "api_key_env": "AZURE_OPENAI_API_KEY",
    "api_version_env": "AZURE_OPENAI_API_VERSION"   // optional; defaults 2024-10-21
  },
  "llama-3.3-70b": {
    "backend": "vllm",
    "base_url": "http://localhost:8000/v1",
    "model": "meta-llama/Llama-3.3-70B-Instruct",
    "api_key_env": "VLLM_API_KEY"                   // optional; defaults "EMPTY"
  }
}
```

### 2. Registry loader (two readers, one format)

Both halves read the same `models.json`:

- **Python** (`chart_review_deepagents`) — for `make_model()` at run time.
- **TypeScript** (server) — for the `/api/deepagents/models` route.

**Zero-config back-compat:** if `models.json` is absent, the loader synthesizes
a single default entry from existing env (`DEEPAGENTS_LLM_BACKEND` +
`AZURE_OPENAI_*` / `VLLM_*`), keyed by the deployment/model name. Existing
setups keep working with no new file.

### 3. Availability resolution

An entry is **available** iff its prerequisites are present:

- `azure` → the env vars named by `api_key_env` and `endpoint_env` are set.
- `vllm` → `base_url` is declared (always true once in the file).

The **default** is the first available entry (or a marked default if available).
The route returns **all declared entries, each flagged with `available`**, so
the UI can grey out unavailable ones; `default` points to an available entry. If
**no** entry is available, `default` is `null` and the UI surfaces a
configuration message and blocks Run.

### 4. Route: `GET /api/deepagents/models`

Replaces the singular `GET /api/deepagents/model`. Returns:

```jsonc
{
  "models": [
    { "id": "gpt-4o", "backend": "azure", "label": "azure · gpt-4o", "available": true },
    { "id": "llama-3.3-70b", "backend": "vllm", "label": "vllm · meta-llama/Llama-3.3-70B-Instruct", "available": true }
  ],
  "default": "gpt-4o"
}
```

Presence-only: never returns secrets, only backend/label/availability.

### 5. Provider + sidecar

- **Provider** (`packages/agent-provider-deepagents`): add `model` to `RunSpec`
  and set it from `input.model` (currently dropped).
- **Sidecar** (`models.py`): `make_model(model_key)` loads the registry, looks
  up the key, and builds the matching LangChain client (`AzureChatOpenAI` or
  vLLM `ChatOpenAI`). No key → default entry.

### 6. UI

`client/src/ui/PilotsTab/AgentConfigPanel.tsx`: the read-only model badge
becomes a per-agent `<select>` populated from `/api/deepagents/models`,
defaulting to the route's `default`. Re-add `model` to `AgentSpecForm` and to
`specsToApi()` in `NewSessionDialog.tsx`. When zero models are available, render
the configuration message instead of the picker and disable starting a session.

## Data flow (worked example)

Two agents, mixed backends:

1. User picks `gpt-4o` for agent_1 and `llama-3.3-70b` for agent_2.
2. `specsToApi()` sends `agent_specs: [{id, ..., model:"gpt-4o"}, {id, ..., model:"llama-3.3-70b"}]`.
3. The batch runner makes two `runAgent()` calls, each with its own `model`.
4. The deepagents provider writes two RunSpecs with `model:"gpt-4o"` and
   `model:"llama-3.3-70b"` respectively.
5. Each sidecar subprocess resolves its key from the registry and builds the
   right client. agent_1 talks to Azure; agent_2 talks to vLLM.

## Error handling

- **Unknown/unavailable key at run time:** the sidecar emits a clear AgentEvent
  `error` for that agent only — `model 'X' not in registry` or `vLLM unreachable
  at <url>` — and that agent's run fails. Other agents and the app are
  unaffected.
- **No models available:** the route returns `default: null` (entries may still
  be listed, all flagged `available: false`); the UI shows the configuration
  message and disables Run, rather than letting a run start that will fail.
- **Malformed `models.json`:** loader logs and falls back to env synthesis (TS
  route) / emits a startup error event (sidecar), rather than crashing.

## Testing

- **Python:** registry loader — file present, file absent → env synthesis,
  unknown key, availability computation; `make_model()` routing for azure vs
  vllm with mocked LangChain clients.
- **TypeScript:** route returns available entries + correct default; asserts no
  secret value appears in the payload; empty-registry → `default: null`.
- **UI:** dropdown renders the route's options and default; empty-state message
  renders when no models available.
- **Integration (provider level):** two specs with two keys produce two RunSpecs
  whose `model` fields differ.

## Files touched

- Create: `python/models.example.json`
- Create: `python/chart_review_deepagents/registry.py` (loader + availability)
- Modify: `python/chart_review_deepagents/models.py` (`make_model(key)`)
- Modify: `packages/agent-provider-deepagents/src/index.ts` (RunSpec.model)
- Modify: `server/misc-routes.ts` (`/api/deepagents/models`)
- Create: `server/lib/model-registry.ts` (TS loader, shared by the route)
- Modify: `client/src/ui/PilotsTab/AgentConfigPanel.tsx` (per-agent select)
- Modify: `client/src/ui/Workspace/NewSessionDialog.tsx` (restore `model` in payload)
- Modify: `client/src/ui/Workspace/PhaseTry.tsx` (display selected model per agent)
- Update: `.gitignore` (`python/models.json`)
- Tests alongside each.
