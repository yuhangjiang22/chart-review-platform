# Changelog

Work log for `chart-review-platform-light` (forked from `chart-review-platform-v2`)
and the in-progress port of its improvements back to v2.

## chart-review-platform-light

### 0. Fork + reduction of v2
- Forked v2; made **deepagents** the only agent provider (`DeepAgentsProvider`,
  Python sidecar with model factory + AgentEvent emitter + entrypoint, MCP
  subprocess routing); removed the claude/codex providers.
- **Notes-only** — stripped OMOP tools, fixtures, and prompt lines.
- **Removed NER + adherence** — packages, server routes, UI panes, types,
  proposal paths.
- Collapsed the workflow to **TRY → VALIDATE → DECIDE** (dropped 4 phases).
- Pre-authored the `lung-cancer-phenotype-light` task (cancer_type + disease_extent).
- DECIDE = per-field agent-vs-human performance report.
- Self-contained `CORPUS_ROOT`; README / CLAUDE.md / .env.example; green vitest;
  e2e spec updated.

### 1. UX refinements (from running the app)
- Real provider shown ("deepagents", not hardcoded "Claude"); OMOP "Structured"
  tab removed; tighter evidence-citation guidance; open session/run creation
  (no methodologist gate); faithfulness rejection made recoverable (not a fatal
  crash); evidence anchor required even for `no_info`.
- Performance: scores only human-validated fields; per-agent leaderboard
  (default vs skeptical); scoped to the active session; requires finalized
  validation.
- Wired the missing patient-level `/validate` (+ `/unvalidate`); apply returned
  review_state after Submit; inline editable Rubric panel in TRY; explicit Run
  button (no auto-run); "Open skill rubric" reveal; per-session "Run N"
  numbering; iter-status polling; run-status placement/scroll fixes; removed
  dead Lock button.
- Export validated task package on PERFORMANCE (for larger-cohort runs).

### 2. Per-agent model mixing
- Model registry (Azure/vLLM) via committed `models.example.json` + gitignored
  `python/models.json`; `make_model(key)`; presence-only TS reader;
  `GET /api/deepagents/models`; per-agent dropdown; create/Run blocked when no
  model is configured; honest model display (replaced the inert picker).

### 3. Session-isolated review state + loud-fail
- `review_state` moved to `var/reviews/<sessionId>/<pid>/<taskId>/`; `session_id`
  threaded through review-routes, run-import, performance, export, patient-status,
  and the client.
- Loud-fail: an errored / no-write agent fails (writes an `.error.json` marker,
  promotes no draft); per-patient rollup → complete / complete_with_errors /
  failed; UI surfaces failures.
- **Critical fix:** write-counting moved from the SDK PostToolUse hook (which the
  deepagents subprocess never fires) to the provider-agnostic AgentEvent stream —
  successful agents were being falsely failed.
- UI polish: reactive active-session in App (event, not stale memo); run-card
  readiness from live `run_status` (was stuck "RUNNING"); model shown instead of
  "(env default)"; evidence cards normalized (doc_type / `.txt` / date) and the
  header shows the note type without wrapping; dropped raw `iter_id` from the
  sidebar.
- One-time `var/reviews` wipe migration.

### 4. Deployment runner
- `npm run deploy` — headless CLI (`packages/deploy-runner`) that runs an
  exported package's best agent (by `avg_accuracy`, `--agent` override) on a new
  cohort dir (`<patient_id>/notes/*.txt`), reusing `startBatchRun` + the sidecar +
  faithfulness gate. Outputs `<pid>.json` + `results.csv` + `run_manifest.json`.
- `CHART_REVIEW_PATIENTS_ROOT` override points note-reading at the cohort.
- **Critical fix:** `PATIENTS_ROOT` resolved at call time (was a frozen const that
  broke novel cohorts). Verified end-to-end with a patient id not in the corpus.

Gate status: typecheck 0 · vitest 170 · pytest 15 · deploy verified e2e.

## chart-review-platform-v2 (port in progress)

Porting the light improvements back to v2 (full feature set), one at a time,
correctness first:

1. **Session isolation + loud-fail** — design approved
   (`docs/superpowers/specs/2026-06-08-session-isolated-review-state-design.md`):
   full isolation incl. the publication pipeline (LOCK/methods/κ/deploy/stats)
   reading the active session; loud-fail generalized per task kind (NER's "zero
   spans" is a valid result). Implementation pending.
2. Deployment runner for v2 — planned.
3. UI / model-display polish for v2 — planned.

Per-agent model registry (Azure/vLLM) is light-specific (v2 is claude/codex) and
is not being ported as-is.
