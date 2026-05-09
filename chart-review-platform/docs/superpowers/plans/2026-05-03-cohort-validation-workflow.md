# Cohort + deployment-validation workflow — Implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement.

**Goal:** ship the workflow that produces a *publishable κ number* — agent runs the locked guideline on a real cohort, a stratified sample of patients gets human-validated, deployment-stage κ is the published accuracy. This is item #2 in `2026-05-03-post-mvp-blueprint.md` §8 and the gating capability for going to publication.

**Predecessors (already shipped):**
- Dual-agent MVP (agent invocation infrastructure)
- Skill restructure (phenotype scope-skills, schema_hash, criterion-level rerun)
- Adjudication + proposals pipeline

**Source spec:** `docs/superpowers/specs/2026-05-03-post-mvp-blueprint.md` §3 (deployment regime), §4 (validation regime), §6 (reliability metrics). Read these before starting.

---

## Architecture

A **cohort run** is conceptually similar to a pilot iter, but uses a *locked* guideline against an arbitrary target cohort (not the dev_patient_ids). It produces the same per-patient agent draft shape but lives in a different directory and has different downstream consumers.

```
cohorts/<study_id>/                     ← gitignored (runtime data)
├── manifest.json                       ← cohort definition (which patients, locked SHA, model)
├── runs/<run_id>/
│   ├── manifest.json                   ← extends agent_batch_run manifest
│   ├── status.json                     ← progress
│   └── per_patient/<pid>/agents/<agent_id>.json
│
├── sample/
│   ├── strategy.json                   ← stratified-N config
│   ├── selections/<run_id>.json        ← which patients drawn for validation
│   └── validations/<patient_id>/       ← reviewer's blind validation per patient
│       └── review_state.json           ← same shape as today's per-patient reviews
│
└── reports/<run_id>/
    ├── deployment-kappa.json           ← per-criterion κ + 95% CI
    └── deployment-kappa.md             ← human-readable methods-section snippet
```

The cohort run reuses `startBatchRun` + `runOneAgent` (no new agent invocation logic — locked guideline is just another `task_id`). What's new is the post-run sampling, the validation queue, and the κ computation.

---

## Phase G — Implementation

### G.1: Cohort manifest + start endpoint

**Files:**
- Create: `app/server/cohorts.ts`
- Modify: `app/server/server.ts` (add routes)

- [ ] **Step 1: Define `CohortManifest` interface**

  ```typescript
  // app/server/cohorts.ts
  export interface CohortManifest {
    cohort_id: string;          // e.g., "lung-cancer-2026-real"
    task_id: string;             // points at locked guideline
    guideline_sha: string;       // pinned at lock; published as "this is the version we used"
    patient_ids: string[];       // full target cohort (10s to 10,000s)
    created_at: string;
    created_by: string;
    inclusion_criteria_text?: string;  // free-form; goes into methods §5
    notes?: string;
  }

  export interface CohortRunManifest extends RunManifest {
    cohort_id: string;
    kind: "cohort_batch_run";
  }
  ```

- [ ] **Step 2: Layout helpers**

  ```typescript
  export function cohortsRoot(): string { return path.join(PLATFORM_ROOT, "cohorts"); }
  export function cohortDir(cohortId: string): string { return path.join(cohortsRoot(), cohortId); }
  export function cohortManifestPath(cohortId: string): string { return path.join(cohortDir(cohortId), "manifest.json"); }
  export function cohortRunDir(cohortId: string, runId: string): string { return path.join(cohortDir(cohortId), "runs", runId); }
  ```

- [ ] **Step 3: `defineCohort(opts)` — register a cohort**

  Validates `task_id` exists and is locked, that all `patient_ids` are real corpus entries, writes `cohorts/<cohort_id>/manifest.json`.

- [ ] **Step 4: `startCohortRun(cohortId, opts)` — kick off agent batch**

  Reads the cohort manifest, calls `startBatchRun` with `cohort_id` propagated through to the run manifest, redirects per-patient outputs to `cohorts/<cohort_id>/runs/<run_id>/per_patient/...` instead of the default `runs/<run_id>/...`. Two paths to consider:
  - (a) Add a `runs_root_override` option to `startBatchRun` so cohort runs land under `cohorts/...`
  - (b) Run under `runs/<run_id>/` as today and just record the cohort linkage in the manifest

  Choose (b) — simplest, doesn't require touching the run pipeline. Cohorts/<id>/runs/<run_id> can be a symlink or just a JSON pointer.

- [ ] **Step 5: API routes in `server.ts`**

  - `POST /api/cohorts` — define a cohort (methodologist privilege)
  - `GET /api/cohorts` — list
  - `GET /api/cohorts/:cohortId` — get manifest + runs list
  - `POST /api/cohorts/:cohortId/runs` — start a cohort run
  - `GET /api/cohorts/:cohortId/runs/:runId/status` — proxy to run status

- [ ] **Step 6: Tests**

  Unit test the cohort-defining + manifest-writing logic. The actual agent invocation reuses existing `startBatchRun` paths — those don't need new tests.

- [ ] **Step 7: Commit**

  `feat(cohorts): cohort manifest + start endpoint`

### G.2: Stratified sampling

**Files:**
- Create: `app/server/cohort-sampling.ts`
- Test: `app/server/__tests__/cohort-sampling.test.ts`

- [ ] **Step 1: Define `SampleStrategy`**

  ```typescript
  export interface SampleStrategy {
    n_total: number;             // e.g., 50
    stratify_by: string;          // criterion field_id used for stratification (typically the final label)
    balance: "equal" | "proportional";  // equal = N/2 from each stratum; proportional = match population
    seed: number;                 // for reproducibility
  }

  export function drawStratifiedSample(
    cohortDraftsByPatient: Record<string, AgentDraft>,
    strategy: SampleStrategy
  ): { selected: string[]; rationale: string };
  ```

- [ ] **Step 2: Implement**

  - Group patients by `stratify_by` field value (e.g., agent answer for `lung_cancer_status`: confirmed / probable / absent)
  - For each stratum, compute target N (equal or proportional)
  - Random sample (seeded) from each stratum
  - Return selected `patient_ids` + a human-readable rationale

  Edge case: if a stratum has fewer patients than the target N for that stratum, take all of them and proportionally redistribute the deficit to other strata.

- [ ] **Step 3: Tests**

  Test with synthetic cohorts of known composition. Verify:
  - Equal balance produces ~N/2 per stratum
  - Proportional balance matches population frequencies
  - Same seed produces same sample (reproducibility)
  - Small-stratum edge case works

- [ ] **Step 4: API**

  `POST /api/cohorts/:cohortId/runs/:runId/sample` with `SampleStrategy` body. Persists selection to `cohorts/<cohort_id>/sample/selections/<run_id>.json`.

- [ ] **Step 5: Commit**

  `feat(cohort-sampling): stratified sample selection`

### G.3: Sample validation queue + UI

**Files:**
- Modify: `app/server/server.ts` (validation queue routes)
- Create: `app/client/src/v2/CohortsTab/` (new tab)

- [ ] **Step 1: Validation flow**

  When a cohort sample is drawn, each patient in the selection enters a "pending validation" state. The reviewer:
  - Sees the agent's answer (possibly hidden until they commit their own — blinding)
  - Reads the chart
  - Commits their own per-criterion answer via the existing `set_field_assessment` MCP tool — but writing into `cohorts/<cohort_id>/sample/validations/<patient_id>/review_state.json` instead of the per-pilot location
  - Toggles to "validated" once all leaf criteria are answered

- [ ] **Step 2: Reuse the existing review UI**

  The dual-agent layout from the MVP isn't needed here — single-agent + reviewer is the canonical mode. Reuse `AdjudicationLayout` or an equivalent single-draft surface. The only change: the read+write paths point at `cohorts/<cohort_id>/sample/validations/<pid>/...` not `reviews/<pid>/<task_id>/...`.

- [ ] **Step 3: Blinding**

  Add a "blind mode" flag that hides the agent's answer until the reviewer commits theirs. The platform already has blinding infrastructure (`BlindedReviewControls.tsx`); reuse.

- [ ] **Step 4: Cohort tab in v2 Studio**

  New surface alongside Pilots tab. Lists cohorts; click into a cohort → see runs; click into a run → see sample status (N validated / N total); click into a patient → review surface.

- [ ] **Step 5: Tests + commit**

  Server tests for validation-state read/write. UI smoke test optional.

  `feat(cohort-validation): sample validation queue + UI`

### G.4: Deployment-stage κ + report

**Files:**
- Create: `app/server/deployment-kappa.ts`
- Modify: `app/server/server.ts` (report route)

- [ ] **Step 1: Compute deployment κ**

  Once N validated patients exist, compute per-criterion κ between agent and reviewer using the existing `kappa.ts` module. For non-categorical criteria (e.g., `lowest_hemoglobin_in_window`), use the typed reliability dispatch (per blueprint §6 — that's a separate item, but stub here).

- [ ] **Step 2: Confidence intervals**

  Cohen's κ has a closed-form CI based on standard error. Implement the formula (or reuse if existing). Required for publication.

- [ ] **Step 3: Output `deployment-kappa.{json,md}`**

  ```
  cohorts/<cohort_id>/reports/<run_id>/deployment-kappa.json
  ├── per_criterion: [{ field_id, κ, ci_lower, ci_upper, n }]
  ├── overall_κ: number
  ├── overall_ci: [number, number]
  └── n_total_patients: number

  deployment-kappa.md
  └── markdown methods-section snippet ready to paste into a paper
  ```

- [ ] **Step 4: Methods-section integration**

  The existing `chart-review-methods` skill should consume `deployment-kappa.json` to populate block 6 of the methods section. Verify by running it against this synthetic cohort.

- [ ] **Step 5: API + commit**

  `GET /api/cohorts/:cohortId/runs/:runId/report` returns the report JSON.

  `feat(deployment-kappa): compute and persist deployment-stage agreement`

### G.5: End-to-end smoke test

- [ ] **Step 1: Synthetic cohort**

  Use the existing `corpus/patients/` fixtures. Define cohort with all available patients (~20 across all difficulty buckets). Lock the existing `lung-cancer-phenotype` guideline if not locked.

- [ ] **Step 2: Run + sample + validate**

  - Start cohort run with `claude-haiku-4.5` (cost ~$5 for 20 patients)
  - Draw a stratified sample of N=10 (equal balance across `lung_cancer_status`)
  - Manually validate the 10 sampled patients via the reviewer UI
  - Generate the deployment-kappa report

- [ ] **Step 3: Verify outputs**

  - `deployment-kappa.json` exists with per-criterion κ + CIs
  - `deployment-kappa.md` is publication-ready
  - The chart-review-methods skill can consume the JSON and produce a methods paragraph

- [ ] **Step 4: Commit milestone**

  `milestone: cohort + sample validation produces publishable κ end-to-end`

---

## Out of scope (deferred)

- **Cohort patient ingestion from real EHR** — corpus is the source for now; production EHR integration is separate
- **Real-time monitoring during long cohort runs** — the existing `runs/<run_id>/status.json` polling is sufficient
- **Multi-reviewer consensus on the sample** — for MVP, single reviewer is fine; multi-reviewer with consensus computation is a follow-up
- **Deployment-stage κ vs calibration κ "gap" warning** — should be surfaced in the UI for methodologist attention; defer until both numbers exist on a real run

---

## Estimated effort

| Phase | Effort |
|---|---|
| G.1 cohort manifest + endpoint | 0.5 day |
| G.2 stratified sampling | 0.5 day |
| G.3 validation queue + UI | 1–2 days (UI is the long pole) |
| G.4 deployment κ + report | 0.5 day |
| G.5 end-to-end test | 0.5 day (~$5 in agent runs) |

Total: ~3–4 days of focused build.
