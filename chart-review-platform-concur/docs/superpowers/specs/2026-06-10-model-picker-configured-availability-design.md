# Model picker reflects only genuinely-configured backends

**Date:** 2026-06-10
**Status:** approved (design)

## Problem

The session-create model picker offers `qwen3-32b` (and marks it the default)
even when no vLLM server is wired up. It appears whenever `VLLM_BASE_URL` is
merely non-empty — and the shipped `.env.docker.example` sets it to the
placeholder `http://your-vllm-host:8000/v1`. A user copies the example env,
sees `qwen3-32b` pre-selected, creates a session, and the run fails at call
time with a confusing `Could not resolve host: your-vllm-host`.

The intended behavior: a model is offered **only after its backend is actually
wired up**. Until then it must not be a selectable option.

## Root cause

Availability is computed as "the endpoint env var is set", in two mirrored
readers:

- `server/lib/model-registry.ts` → `available()`:
  `if (entry.base_url_env) return !!env[entry.base_url_env];`
- `python/chart_review_deepagents/registry.py` → `_available()`:
  `if entry.get("base_url_env"): return bool(env.get(entry["base_url_env"]))`

The placeholder string is non-empty, so both report `available: true`. The
client machinery is already correct — `useDeepagentsModels` filters to
`availableModels` and exposes a `noModels` gate; `AgentConfigPanel` renders only
available models, disables the picker when none, and shows a "No model
configured" message; `NewSessionDialog` disables **Create session** on
`noModels`. The bug is purely the wrong `available` value feeding all of that.

## Design

Redefine "available" as **configured, not placeholder** (no liveness probe).

### 1. Availability rule (the real change)

A value is **configured** iff it is non-empty AND contains no known placeholder
sentinel (case-insensitive substring match).

- **vLLM**: available iff its base URL (`env[base_url_env]` when `base_url_env`
  is set, else the literal `base_url`) is configured.
- **Azure**: available iff endpoint AND api key are both set AND the endpoint is
  configured (not the placeholder).

Apply identically in both readers:
- `server/lib/model-registry.ts` `available()`
- `python/chart_review_deepagents/registry.py` `_available()`

### 2. Fail fast at run time

`registry.py` `resolve()` currently raises only when the base URL / endpoint is
empty. Extend it to raise the same "model `<key>` is not configured (set
`<ENV_VAR>` to a real value)" error when the value is a placeholder, so a run
started outside the UI gate fails with a clear message instead of a DNS error.

### 3. Placeholder sentinels (shared definition)

A small, documented constant per side, holding the exact tokens from
`.env.docker.example` / `.env.example`:

- `your-vllm-host` (vLLM `VLLM_BASE_URL`, from `.env.docker.example`)
- `YOUR-RESOURCE` (Azure `AZURE_OPENAI_ENDPOINT`, from `.env.docker.example`)
- `<resource>` (Azure `AZURE_OPENAI_ENDPOINT`, from the bare-metal `.env.example`)

Matching is case-insensitive, so `YOUR-RESOURCE` and `your-resource` are one
token.

Each side cross-references the other in a comment (the codebase already keeps
the TS/Python registry contract in sync by hand). Matching is case-insensitive
substring containment so trailing paths/ports don't matter.

### 4. UI message polish

The existing `noModels` message in `AgentConfigPanel.tsx` only mentions
`AZURE_OPENAI_*` and `python/models.json`. Add the vLLM path: set
`VLLM_BASE_URL` (to a real server) in `.env`. No structural UI change.

## Testing

- `server/lib/model-registry.test.ts`: placeholder base_url → `available:false`;
  real base_url → `true`; azure placeholder endpoint → `false`; real endpoint+key
  → `true`; `default` falls through to the first *configured* entry.
- `python/tests/test_registry.py`: mirror the same cases for `_available()`;
  `resolve()` raises on a placeholder value.
- Existing `useDeepagentsModels` / `AgentConfigPanel` tests already cover the
  filter + gate; no change unless asserting the new message wording.

## Out of scope (YAGNI)

- No live reachability probe. "Available" means *configured*. A configured but
  currently-down server still appears and surfaces its connection error at run
  time, as today.
- No change to the registry file format (`models.json`) or the
  `/api/deepagents/models` response shape.
