# Deployment Runner — Design

**Date:** 2026-06-07
**Status:** Approved (pending implementation plan)
**Scope:** chart-review-platform-light

## Goal

A headless (non-UI) CLI that takes an **exported task package** plus a **new
cohort directory** and runs the validated agent config on that cohort, writing
per-patient drafts + a summary. It lets a methodologist who validated a small
cohort in the UI deploy the same agent on a larger set of charts.

```
chart-review-deploy \
  --package var/exports/<task>/<exportId> \
  --data-dir /path/to/new_cohort \
  --out      /path/to/results \
  [--agent agent_2]
```

## Inputs

- `--package` — an export dir produced by the PERFORMANCE phase, containing
  `task.json` (`task_id`, `agent_config[]`, `fields[]`) and `performance.json`
  (`agents[].avg_accuracy`).
- `--data-dir` — the new cohort, laid out exactly like the corpus:
  `<data_dir>/<patient_id>/notes/*.txt`. Patient id = subfolder name.
- `--out` — output directory (created if absent).
- `--agent` — optional; force a specific agent id from `agent_config`.

## Decisions (locked in brainstorming)

- **Cohort layout:** `<data_dir>/<patient_id>/notes/*.txt` (corpus shape).
- **Agent selection:** run a **single** agent. Default = the agent with the
  highest `avg_accuracy` in `performance.json`. `--agent <id>` overrides. On a
  tie or missing/`null` performance, default to `agent_1`. Always log the chosen
  agent + the reason.
- **Output:** `--out/<patient_id>.json` (full draft — answers + confidence +
  cited evidence/offsets, the `review_state` `field_assessments` shape) +
  `--out/results.csv` (one row per patient, one column per field) +
  `--out/run_manifest.json` (provenance).
- **v1 runs on this platform only** — the rubric is read from the installed
  skill (`.agents/skills/<task>/…`) via MCP, not bundled from the package.
  Cross-machine portability is out of scope.
- **Model = the `.env`-configured model** (the deepagents sidecar always uses
  it). The runner warns — does not block — when the package's recorded
  `agent_config.model` differs from the resolved env model.

## Architecture — a thin CLI over `startBatchRun`

The runner reuses the existing batch driver `startBatchRun`
(`packages/infra-batch-run/src/runs.ts`), the same one the UI uses. The prompt,
the deepagents sidecar, the MCP server, the faithfulness gate, and the B1
loud-fail logic are all reused unchanged — the runner adds only orchestration.

### Note source — `CHART_REVIEW_PATIENTS_ROOT` override

Notes resolve via `PATIENTS_ROOT = CORPUS_ROOT/patients`
(`packages/patients/src/index.ts:29`). Add an optional env override so the
runner can point `PATIENTS_ROOT` directly at `--data-dir`:

```ts
export const PATIENTS_ROOT =
  process.env.CHART_REVIEW_PATIENTS_ROOT ?? path.join(CORPUS_ROOT, "patients");
```

`--data-dir` is `<patient_id>/notes/*.txt`, exactly what `listNotes`/`readNote`
expect under `PATIENTS_ROOT`. One line, env-gated; no behavior change when the
override is unset.

### Components

- `packages/deploy-runner/src/index.ts` — the CLI. Single responsibility:
  orchestrate a deployment run. Sub-units (each a small pure-ish function):
  - `loadPackage(dir)` → `{ taskId, agentConfig, performance }` (parse + validate
    the package files; throw a clear error if malformed/missing).
  - `selectAgent(agentConfig, performance, overrideId)` →
    `{ spec, reason }` (best `avg_accuracy`, override, tie/fallback rules).
  - `enumeratePatients(dataDir)` → `string[]` (subdirs with a non-empty
    `notes/` dir; skip the rest, log skipped).
  - `runCohort(taskId, spec, patientIds)` → runs `startBatchRun` with
    `CHART_REVIEW_PATIENTS_ROOT=dataDir`, `provider="deepagents"`,
    `agent_specs=[spec]`; polls `getRunStatus(runId)` until
    `state !== "running"`; returns the run id + final status.
  - `collectResults(runId, status, fields, outDir)` → uses the final
    `RunStatus.per_patient` to classify each patient: `state==="complete"` →
    read its promoted draft (`agentDraftPath`) and write `<out>/<pid>.json` + a
    `results.csv` row; `state==="error"` → failed (no draft; recorded in the
    manifest, omitted from the CSV). Writes `<out>/run_manifest.json` last.
- Wiring: a `deploy` npm script (`tsx packages/deploy-runner/src/index.ts`) so
  it runs as `npm run deploy -- --package … --data-dir … --out …`.

### Flow

1. `loadPackage` → taskId, agentConfig, performance.
2. Resolve the env model (`DEEPAGENTS_LLM_BACKEND` + deployment/model); warn if
   it differs from `agentConfig[selected].model`.
3. `selectAgent` → the single spec to run (+ logged reason).
4. `enumeratePatients(--data-dir)`.
5. `runCohort` — `startBatchRun({ task_id, patient_ids, agent_specs:[spec],
   provider:"deepagents", started_by:"deploy-runner" })` with
   `CHART_REVIEW_PATIENTS_ROOT` set; poll to completion.
6. `collectResults` → write the three outputs.
7. Print a summary: chosen agent, model, `n_ok`/`n_failed`, out dir.

### Output formats

- `<out>/<patient_id>.json` — the agent's draft for that patient: the
  `field_assessments` array (each `{ field_id, answer, confidence, evidence[],
  rationale }`), plus `{ patient_id, task_id, agent_id, model }`.
- `<out>/results.csv` — header `patient_id,<field_1>,<field_2>,…`; one row per
  successful patient with the chosen agent's answer per field. Failed patients
  are omitted from the CSV (listed in the manifest).
- `<out>/run_manifest.json` —
  `{ package_dir, task_id, agent_id, agent_reason, model, env_model,
     model_mismatch_warning, data_dir, n_patients, n_ok, n_failed,
     failed_patient_ids[], started_at, finished_at, run_id }`.

## Error handling

- **Bad inputs:** missing/malformed `--package` files, nonexistent `--data-dir`,
  or zero enumerable patients → exit non-zero with a clear message before any
  run starts.
- **Per-patient isolation:** reused from `startBatchRun` — one patient's failure
  (unreadable notes, agent error/no-write per B1) does not stop the run. Failed
  patients are counted in `n_failed`, listed in `run_manifest.json`, and omitted
  from `results.csv`.
- **Whole-run failure:** the CLI exits non-zero only if **every** patient failed
  (so a deploy that produced nothing is a visible failure).
- **Model mismatch:** warn and proceed (not a hard stop).

## Testing

- `selectAgent` — best by `avg_accuracy`; `--agent` override; tie → `agent_1`;
  missing/`null` performance → `agent_1`; each logs a reason (unit).
- `enumeratePatients` — picks dirs with `notes/*.txt`, skips dirs without notes
  and stray files (unit, over a temp dir).
- `loadPackage` — parses a valid package; throws a clear error on
  missing/malformed `task.json`/`performance.json` (unit).
- `collectResults` — given fixture drafts, writes correct `<pid>.json`, a CSV
  with the right header + rows, and a manifest with accurate counts; failed
  patients omitted from CSV but present in the manifest (unit, temp dirs).
- `PATIENTS_ROOT` override — `listNotes` reads from `CHART_REVIEW_PATIENTS_ROOT`
  when set (unit).
- End-to-end (manual, documented): run the CLI against a small 2–3 patient
  `--data-dir` and confirm drafts + CSV + manifest are produced and faithful.

## Files touched

- Modify: `packages/patients/src/index.ts` — `PATIENTS_ROOT` env override.
- Create: `packages/deploy-runner/` — `package.json`, `src/index.ts` (CLI),
  `src/select-agent.ts`, `src/enumerate-patients.ts`, `src/load-package.ts`,
  `src/collect-results.ts`, and tests alongside.
- Modify: root `package.json` — add the `deploy` script.
- Update: `README.md` — a short "Deploy on a larger cohort" section.

## Non-goals (v1)

- Cross-machine / portable packages (bundling + loading the rubric from the
  package). v1 requires the task installed on the running platform.
- Running multiple agents (dual-agent) on the new cohort — single agent only.
- Computing accuracy on the new cohort (it's unlabeled — no gold).
- Resuming/​restarting a partially-completed deployment run.
