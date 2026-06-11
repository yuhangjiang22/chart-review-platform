# Increment 1 — Restore the JUDGE phase (concur ← v2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Re-wire the LLM-judge phase into concur's workflow. The judge BACKEND already exists in concur (vestigial after the "dropped 4 phases" trim); only the phase shell + trigger pane are missing.

**Context — program:** First of five increments extending `chart-review-platform-concur` toward `chart-review-platform-v2` feature parity (Judge → claude+codex providers → NER → adherence → publication phases). Each increment is its own design→plan→build→verify cycle. Providers decision: add claude+codex alongside deepagents (later increment). The judge runs on whatever the run's provider is — here, **deepagents (Azure)** — because `judge.ts` calls the provider-agnostic `runAgent()`, not the Anthropic SDK.

**Already present in concur (do NOT re-port):** `server/lib/judge.ts`, `server/lib/judge-batch.ts`, GET+POST `/api/pilots/:taskId/:iterId/judge` routes, `client/src/PatientReview/JudgePanel.tsx`, `PatientReview` judge-analyses fetch+render (lines ~301/585), `packages/disagreements`, `packages/workflow-phase-judge` (exports `PHASE_JUDGE`, `optional:true`), `packages/model-config` (`"judge"` slot), `.agents/skills/chart-review-judge/`, multi-agent runs (`agents/<id>.json`), `confidence` on FieldAssessment.

**Missing (this increment):** `client/src/ui/Workspace/PhaseJudge.tsx`; `JUDGE` in `client/src/ui/Workspace/phases.ts`; the judge model must resolve to a deepagents-servable Azure model (it currently defaults to `anthropic/claude-sonnet-4.6`).

---

## Task 1: Wire JUDGE into the workflow shell

**Files:** Modify `client/src/ui/Workspace/phases.ts`.

- [ ] **Step 1 — read** v2's `client/src/ui/Workspace/phases.ts` JUDGE entry: `{ id:"JUDGE", label:"Judge", slug:"judge", group:"iter", optional:true }`, placed between TRY and VALIDATE. Note v2 also imports `PHASE_JUDGE` from `@chart-review/workflow-phase-judge` if concur's phases.ts derives from the phase modules — match concur's existing pattern (it may hardcode the array).
- [ ] **Step 2 — add `"JUDGE"`** to concur's `export type Phase = "TRY" | "VALIDATE" | "DECIDE"` union → add `"JUDGE"`.
- [ ] **Step 3 — insert the JUDGE def** into `PHASE_DEFS` between the TRY and VALIDATE entries: `{ id: "JUDGE", label: "Judge", slug: "judge", group: "iter", optional: true }`. (concur's `PhaseDef` may not have an `optional` field — check the type; add `optional?: boolean` to the `PhaseDef` interface if absent, mirroring v2, so the pill bar can render it skippable.)
- [ ] **Step 4 — typecheck** (`npm run typecheck`). EXPECT errors at the pane router (a `switch`/map over `Phase` that's now non-exhaustive — it lacks a JUDGE case). Record that location; Task 2 fixes it.
- [ ] **Step 5 — commit** `feat(concur): add JUDGE to the workflow phase registry`.

## Task 2: Port the PhaseJudge pane + route it

**Files:** Create `client/src/ui/Workspace/PhaseJudge.tsx`; Modify the Workspace pane router (the component that renders the active phase — find it: `grep -rn 'PhaseTry\|PhaseValidate' client/src/ui/Workspace/*.tsx`, likely `index.tsx`).

- [ ] **Step 1 — read** v2's `client/src/ui/Workspace/PhaseJudge.tsx` (252 lines). It: GETs `/api/pilots/:taskId/:iterId/judge` on mount + polls every 4s while running; POSTs the same path to start a batch ("Run judge analysis"); renders status (cells analyzed / cost / running) and, for NER, an inline `<NerJudgeCard>`.
- [ ] **Step 2 — create concur's `PhaseJudge.tsx`** as a PHENOTYPE-ONLY copy: drop the NER branch (`NerJudgeCard`, `task_kind==="ner"` rendering) — concur has no NER yet. Keep the GET poll + POST trigger + status panel. Match concur's prop conventions: it needs `taskId` + the active `iterId` (how does `PhaseValidate` get its `iterId`? mirror that — likely from the active pilot iteration resolved in the Workspace). If concur's review/pilot calls are session-scoped (it has `session-reviews.ts`), thread `session_id` the same way concur's other phase panes do; the judge routes read pilot-scoped `judge_analyses.json` + run-dir agent drafts, so confirm whether they require `session_id` (likely not — verify against `server/pilot-routes.ts:272/497`).
- [ ] **Step 2b — auth/fetch:** use concur's `authFetch` (or whatever PhaseValidate uses), not raw `fetch`.
- [ ] **Step 3 — route it:** in the Workspace pane router, add the `JUDGE → <PhaseJudge .../>` case (the non-exhaustive switch from Task 1 Step 4). Pass the same `taskId`/`iterId`/session props the sibling panes get.
- [ ] **Step 4 — typecheck (0) + `npm run build:client`** (builds).
- [ ] **Step 5 — commit** `feat(concur): PhaseJudge pane (phenotype) + route it`.

## Task 3: Judge model resolves to a deepagents-servable model

**Files:** Modify `.env` (local) + `.env.example`; possibly `packages/model-config/src/index.ts`.

- [ ] **Step 1 — diagnose:** `JUDGE_MODEL = modelFor("judge") ?? modelFor("default")` (`server/lib/judge.ts:85`). `modelFor("judge")` defaults to `anthropic/claude-sonnet-4.6` — the deepagents/Azure sidecar can't serve that (it resolves models via `python/models.json` keys, e.g. `gpt-4o`). So the judge would fail to start on deepagents.
- [ ] **Step 2 — fix via env:** set `CHART_REVIEW_JUDGE_MODEL=<a python/models.json key, e.g. gpt-4o>` in `.env` (and document it in `.env.example`). Confirm `modelFor` reads `CHART_REVIEW_JUDGE_MODEL` (concur's model-config has that env precedence). This keeps the judge on the deepagents/Azure path without code changes.
- [ ] **Step 3 — (optional) deepagents default:** if cleaner, add a `DEEPAGENTS_DEFAULTS`/provider-aware default for `"judge"` in `model-config` so a fresh concur checkout works without the env var. Decide during build; the env var is sufficient for now.
- [ ] **Step 4 — restart the dev server** (env read at boot). Commit any `.env.example`/model-config change: `chore(concur): judge model defaults to an Azure deployment for deepagents`.

## Task 4: End-to-end verification (the real test)

- [ ] **Step 1 — typecheck 0, `npx vitest run` green, `npm run build:client` builds.**
- [ ] **Step 2 — run the app** (`npm run dev`), create/select a session with **≥2 agents** (default + skeptical) on a phenotype patient where they'll disagree, Start iter, let TRY complete (drafts written to `runs/<id>/per_patient/<pid>/agents/agent_{1,2}.json`).
- [ ] **Step 3 — JUDGE phase:** the JUDGE pill appears between TRY and VALIDATE; click into it; click "Run judge analysis". Confirm the batch runs on the **deepagents/Azure** provider (watch `var/runs`/logs), writes `<skill>/pilots/<iter>/judge_analyses.json`, and the pane shows "N cells analyzed".
- [ ] **Step 4 — VALIDATE:** open a judged criterion; confirm `JudgePanel` renders the judge's suggested answer + reasoning (PatientReview already wires this). Confirm derived fields show no JudgePanel.
- [ ] **Step 5 — loud-fail sanity:** if the judge model is misconfigured, the batch should surface an error in the pane, not silently produce empty analyses.

## Self-review
- JUDGE is `optional` (reviewers can skip TRY→VALIDATE directly); nothing gates VALIDATE on judge having run (matches v2).
- Judge runs on the run's provider (deepagents) via `runAgent`; no Anthropic SDK dependency introduced.
- Phenotype-only: no NER branch ported (NER judge comes with the NER increment).
- No backend re-port: `judge.ts`/`judge-batch.ts`/routes/`JudgePanel`/skill already exist — this increment only restores the workflow shell + trigger pane + model config.
