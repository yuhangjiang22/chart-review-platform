# Per-Agent Model Mixing (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Replace the hardcoded model quick-picks + `(env default)` placeholder in the agent picker with a registry-backed honest picker that shows only models configured for this deployment (greys out the rest), per `docs/superpowers/specs/2026-06-09-per-agent-model-mixing-design.md`.

**Architecture:** v2 already forwards `agent_spec.model` to the provider, so no provider/sidecar change. New: a registry file (`config/models.json` gitignored + `config/models.example.json` committed), a TS loader (`server/lib/model-registry.ts`) with zero-config env synthesis + availability, a `GET /api/models` route, and an `AgentConfigPanel` `<select>`. Ports light's `2026-06-06-per-agent-model-mixing` (TS-only — v2 has no Python half).

**Tech:** TypeScript, Vitest, React. Branch: `feat/v2-session-isolation-loud-fail` (user: "I don't care about branch").

**Reference:** light `server/lib/model-registry.ts`, `server/misc-routes.ts` (`/api/deepagents/models`), `client/src/ui/PilotsTab/AgentConfigPanel.tsx`.

---

## Task M1: registry file + TS loader (TDD)

**Files:** Create `config/models.example.json`; Create `server/lib/model-registry.ts`; Create `server/lib/model-registry.test.ts`; Modify `.gitignore`.

- [ ] **Step 1 — read light's loader** `../chart-review-platform-light/server/lib/model-registry.ts` for the shape (read entries, availability, default, env synthesis). Adapt: v2 backends are `"codex"` / `"claude"` (not azure/vllm); availability = `api_key_env` set AND `backend === activeProvider()`.

- [ ] **Step 2 — `config/models.example.json`** (committed template):
```jsonc
{
  "gpt-5.2":   { "backend": "codex",  "model": "gpt-5.2",                    "label": "GPT-5.2 (Azure)", "api_key_env": "AZURE_OPENAI_API_KEY", "default": true },
  "gpt-4o":    { "backend": "codex",  "model": "gpt-4o",                     "label": "GPT-4o (Azure)",  "api_key_env": "AZURE_OPENAI_API_KEY" },
  "haiku-4.5": { "backend": "claude", "model": "anthropic/claude-haiku-4.5", "label": "Claude Haiku 4.5","api_key_env": "ANTHROPIC_API_KEY" }
}
```

- [ ] **Step 3 — `.gitignore`** add `config/models.json` (and `chart-review-platform-v2/config/models.json` if the ignore file is repo-root-relative — check existing entries).

- [ ] **Step 4 — write failing tests** `server/lib/model-registry.test.ts` (vitest, stub env with `vi.stubEnv`):
  - `loadModelRegistry()` reads `config/models.json` when present (point it at a temp file via an injectable path arg or `CHART_REVIEW_MODELS_PATH` env — mirror light's testability).
  - file absent → synthesizes ONE default entry from env: codex branch (AGENT_PROVIDER=codex, AZURE_OPENAI_API_KEY set, codex `active_model` → entry `{backend:"codex", model:<active_model>, available:true}`); claude branch (AGENT_PROVIDER=claude, ANTHROPIC_API_KEY set → entry from `modelFor("default")`).
  - availability: entry `available` iff `api_key_env` present AND `backend===activeProvider`. A claude entry with codex active → `available:false`.
  - default = first available (honor `default:true` if that one is available); none available → `default:null`.
  - malformed JSON → falls back to env synthesis (no throw).
  - **no-secrets:** the resolved listing exposes only `id/backend/label/available` (+ default) — never the `api_key_env` value or any secret.

- [ ] **Step 5 — implement `server/lib/model-registry.ts`.** Exports:
```ts
export interface ResolvedModel { id: string; backend: "codex" | "claude"; label: string; available: boolean; model: string; }
export interface ModelRegistryResult { models: ResolvedModel[]; default: string | null; active_provider: "codex" | "claude"; }
export function loadModelRegistry(): ModelRegistryResult;
```
`activeProvider()` = `(process.env.AGENT_PROVIDER ?? "claude") === "codex" ? "codex" : "claude"`. For codex zero-config synth, read the codex `active_model` (reuse the codex-config reader behind `/api/diagnostics/api-providers` in `misc-routes.ts` — extract/share it; if not easily shared, read `.codex/config.toml`'s `model`). For claude, use `modelFor("default")` from `@chart-review/model-config`.

- [ ] **Step 6 — run tests + typecheck.** `npx vitest run server/lib/model-registry.test.ts` PASS; `npm run typecheck` 0.

- [ ] **Step 7 — commit** `feat(v2): model registry loader + example (zero-config synth + availability)`.

## Task M2: `GET /api/models` route

**Files:** Modify `server/misc-routes.ts`; Modify its test (or add `server/misc-routes.test.ts`).

- [ ] **Step 1 — add route** in `misc-routes.ts`:
```ts
{ method: "GET", pattern: "/api/models",
  handler: async () => {
    const r = loadModelRegistry();
    return { models: r.models.map(({ id, backend, label, available }) => ({ id, backend, label, available })), default: r.default, active_provider: r.active_provider };
  } },
```
(Strip `model` + any secret from the payload — return only id/backend/label/available.) Keep `/api/agent-roles/default-model` for now (harmless); the client stops using it in M3.

- [ ] **Step 2 — test** the route returns declared entries flagged available, correct default + active_provider, and asserts NO secret/`api_key_env` value or `model` string leaks if we decide model is internal — confirm payload keys are exactly `{id,backend,label,available}`.

- [ ] **Step 3 — typecheck + vitest + commit** `feat(v2): GET /api/models route (presence-only registry listing)`.

> Note: the client needs the chosen entry's `model` string to put in `agent_spec.model`. Decision: the route's per-entry payload includes `id` only for availability; but the client must map id→model. SIMPLEST: include `model` in the route payload too (the model string is NOT a secret — it's just an identifier like "gpt-5.2"). So the per-entry payload is `{id, backend, label, available, model}`; only keys/endpoints are secret. Update Step-1/2 accordingly: include `model`, exclude `api_key_env`.

## Task M3: AgentConfigPanel registry select + verify wiring

**Files:** Modify `client/src/ui/PilotsTab/AgentConfigPanel.tsx`; verify `client/src/ui/Workspace/NewSessionDialog.tsx` (`specsToApi` already sends `model`) + `client/src/ui/Workspace/PhaseTry.tsx` (already shows `s.model`).

- [ ] **Step 1 — read light's `AgentConfigPanel.tsx`** for the `<select>` + empty-state + disable-Create pattern.

- [ ] **Step 2 — replace** in v2 `AgentConfigPanel.tsx`:
  - Remove `QUICK_PICK_MODELS`, the free-text `<input>` for model, the `(env default: …)` placeholder, and the `/api/agent-roles/default-model` fetch.
  - Fetch `GET /api/models` once; store `{models, default}`.
  - Per agent: a `<select>` whose options are the registry entries. Option `value` = entry `model` string (what goes into `spec.model`); label = entry `label` (+ "· (backend not active)" when `!available`); unavailable options `disabled`. Default a new/blank spec's model to the route `default`'s model string.
  - When `models.filter(m => m.available).length === 0`: render the config message ("No models configured — add `config/models.json` or set `AZURE_OPENAI_API_KEY` / `ANTHROPIC_API_KEY` for the active provider (`<active_provider>`)") and surface a `disabled`/blocked signal so the parent can disable Create/Run.

- [ ] **Step 3 — block Create/Run when none available.** Mirror light: AgentConfigPanel exposes whether any model is available (callback or derived in parent); `NewSessionDialog`'s submit/Start button is `disabled` when no model is available. Trace how the parent gates submit and wire the disable.

- [ ] **Step 4 — verify payload + display.** Confirm `specsToApi()` still sends `model` (it does, NewSessionDialog:46) and PhaseTry shows the chosen model (it does, :392 `s.model || "(server default model)"`). Adjust PhaseTry's fallback text only if needed.

- [ ] **Step 5 — typecheck + `npm run build:client` + vitest + commit** `feat(v2): registry-backed per-agent model picker (drop hardcoded quick-picks)`.

## Self-review checklist
- No secret (`api_key_env` value, keys, endpoints) in the `/api/models` payload.
- Availability requires backend === active provider (claude models grey out under codex).
- Zero-config: absent `config/models.json` still yields a working default for the active provider.
- Empty-available → Create/Run blocked, config message shown.
