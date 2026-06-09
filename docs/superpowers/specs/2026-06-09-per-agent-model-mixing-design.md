# Per-Agent Model Mixing (v2 port) — Design

**Date:** 2026-06-09
**Status:** Approved (pending implementation plan)
**Scope:** chart-review-platform-v2
**Ports:** `chart-review-platform-light/docs/superpowers/specs/2026-06-06-per-agent-model-mixing-design.md`

## Goal

Replace the hardcoded model quick-picks (`anthropic/claude-haiku-4.5`,
`claude-sonnet-4-6`, `gpt-5.2`, `gpt-4o`) and the `(env default: …)` placeholder
in the agent picker with a **registry of named models that actually exist for
this deployment**. Each agent in a run picks a model from the registry; the
picker shows only configured models (greys out the rest) and tells the user to
configure a backend when none are available. This is the honest picker the
methodologist asked for: "only let user pick ones that exist."

## Motivation

v2's `AgentConfigPanel` shows a hardcoded cross-provider quick-pick list
(`QUICK_PICK_MODELS`) regardless of which provider is active, plus a free-text
override with an `(env default: …)` placeholder. That's dishonest — it offers
`gpt-*` when claude is active and `claude-*` when codex is active, and invents
models (`gpt-4o`) the deployment may not serve. v2 already forwards
`agent_spec.model` through `runAgent()` to the provider (a codex/Azure run on
`gpt-5.2` works today), so unlike light there is **no provider or sidecar wiring
to add** — only an honest, registry-backed picker.

## Non-goals

- Live reachability probing (greying out unreachable endpoints). The registry is
  a pure declaration; reachability surfaces as a run-time error.
- Per-field / per-patient model selection. Selection is per agent.
- Changing the `modelFor()` seam. The registry is a UI/availability layer; the
  server's `modelFor()` default still applies as the fallback when an agent has
  no explicit model.

## Architecture

```
UI dropdown (registry id)
  -> agent_specs[].model = entry.model            (client → server, restored)
  -> runAgent({ model: spec.model })              (ALREADY wired)
  -> claude / codex provider uses it              (ALREADY wired — gpt-5.2 today)
```

Each agent is its own run with its own `spec.model`. No provider change.

## Components

### 1. Model registry

- **`config/models.json`** — gitignored, per-deployment. Declares named entries.
- **`config/models.example.json`** — committed template (mirrors `.env.example`).
- Secret-free: API keys referenced by **env-var name**, never inline.

Entry shape (`backend` is the v2 provider):

```jsonc
{
  "gpt-5.2": {
    "backend": "codex",                  // -> Azure OpenAI via .codex/config.toml
    "model": "gpt-5.2",                  // exact string passed to agent_spec.model
    "label": "GPT-5.2 (Azure)",
    "api_key_env": "AZURE_OPENAI_API_KEY",
    "default": true
  },
  "gpt-4o": {
    "backend": "codex",
    "model": "gpt-4o",
    "label": "GPT-4o (Azure)",
    "api_key_env": "AZURE_OPENAI_API_KEY"
  },
  "haiku-4.5": {
    "backend": "claude",                 // -> Anthropic / OpenRouter
    "model": "anthropic/claude-haiku-4.5",
    "label": "Claude Haiku 4.5",
    "api_key_env": "ANTHROPIC_API_KEY"   // ANTHROPIC_AUTH_TOKEN also satisfies
  }
}
```

### 2. Registry loader — `server/lib/model-registry.ts`

TypeScript reader (v2 has no Python half). Reads `config/models.json`.

**Zero-config back-compat:** if the file is absent, synthesize a single default
entry from existing config — the active provider's configured model: for
`codex`, the `active_model` from `.codex/config.toml` (+ `AZURE_OPENAI_API_KEY`);
for `claude`, `modelFor("default")` (+ `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`).
Existing setups keep working with no new file. Malformed file → log + fall back
to env synthesis (never crash).

### 3. Availability resolution

An entry is **available** iff BOTH:
- its `api_key_env` is set in the environment, AND
- its `backend` equals the active provider (`AGENT_PROVIDER`, default `claude`).

(One run uses one provider, so a model for the non-active backend cannot run —
it is shown but greyed out, exactly like an Azure model when Azure is
unconfigured in light.)

The **default** is the first available entry (preferring one marked `default`).
If **no** entry is available, `default` is `null`.

### 4. Route — `GET /api/models`

```jsonc
{
  "models": [
    { "id": "gpt-5.2", "backend": "codex", "label": "GPT-5.2 (Azure)", "available": true },
    { "id": "haiku-4.5", "backend": "claude", "label": "Claude Haiku 4.5", "available": false }
  ],
  "default": "gpt-5.2",
  "active_provider": "codex"
}
```

Presence-only: never returns secrets (no keys, endpoints, or `api_key_env`
values) — only `id`/`backend`/`label`/`available` + `default` + `active_provider`.

### 5. UI — `client/src/ui/PilotsTab/AgentConfigPanel.tsx`

- Remove `QUICK_PICK_MODELS`, the free-text `<input>`, and the
  `(env default: …)` placeholder + the `/api/agent-roles/default-model` fetch.
- Per-agent `<select>` populated from `/api/models`, defaulting to the route's
  `default`. Unavailable entries render disabled/greyed (label suffixed e.g.
  "(backend not active)").
- When **zero** models are available: render a configuration message
  ("No models configured — add `config/models.json` or set `AZURE_OPENAI_API_KEY`
  / `ANTHROPIC_API_KEY` for the active provider") instead of the picker, and
  **disable Create/Run**.
- The selected entry's **`model` string** (not the registry id) is what flows
  into `agent_spec.model`. Restore `model` in `AgentSpecForm` + the
  `NewSessionDialog` payload; show the chosen model per agent in `PhaseTry`.

## Error handling

- **Unknown/non-served model at run time:** the provider errors for that agent;
  with loud-fail (already shipped) that agent fails and writes an `.error.json`
  marker — other agents/the run are unaffected.
- **No models available:** route returns `default: null`; UI shows the config
  message and blocks Create/Run rather than starting a doomed run.
- **Malformed `config/models.json`:** loader logs + falls back to env synthesis.

## Testing

- **TS loader:** file present; file absent → env synthesis (codex + claude
  branches); malformed → synthesis; availability computation (key present/absent,
  backend match/mismatch); default selection (first available; honors `default`;
  null when none).
- **Route:** returns all declared entries flagged `available`; correct `default`
  + `active_provider`; asserts NO secret value appears in the payload;
  empty/all-unavailable → `default: null`.
- **UI:** dropdown renders options + default; unavailable greyed; empty-state
  message + disabled Create when none available.

## Files touched

- Create: `config/models.example.json`
- Create: `server/lib/model-registry.ts` (loader + availability) + test
- Modify: `server/misc-routes.ts` (`GET /api/models`; the old
  `/api/agent-roles/default-model` may stay or be removed if unused) + test
- Modify: `client/src/ui/PilotsTab/AgentConfigPanel.tsx` (registry `<select>`,
  remove quick-picks/free-text/env-default)
- Modify: `client/src/ui/Workspace/NewSessionDialog.tsx` (model in payload — verify)
- Modify: `client/src/ui/Workspace/PhaseTry.tsx` (display chosen model per agent — verify)
- Update: `.gitignore` (`config/models.json`)
- Tests alongside each.

## Non-goals reminder

This rides on the same branch the user is running (`feat/v2-session-isolation-loud-fail`)
per their "I don't care about branch" preference, so the honest picker lands in
the app they're actively using.
