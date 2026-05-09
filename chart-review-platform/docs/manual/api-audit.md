# Chart Review Platform — REST API Audit

This document is a domain-grouped, hands-on audit of the chart-review-platform server's HTTP surface. The full inventory in `app/server/server.ts` is 118 routes; instead of a flat dump, the audit walks the 16 functional groups a user (or end-to-end test author) actually traverses on the way from "log in" through "lock a guideline, run a cohort, ship deployment-stage findings". Two to four representative endpoints per group were exercised with `curl` against the running dev server (`http://localhost:3001`) using a methodologist token issued by `POST /api/auth/login` for `plan_executor`. Live data was the canonical `lung-cancer-phenotype` task and the `lung-cancer-smoke-test / 2026-05-03T10-52-42-581Z` cohort run already on disk.

All endpoints below sit under `/api`. Status codes are what the server returned during this run; "shape" lists the top-level response keys (or `[…]` for arrays of objects, in which case the inner-element keys are listed).

---

## 1. Auth

The auth surface is shallow on purpose: a single login endpoint mints an opaque token and a `whoami` endpoint echoes back what the server thinks of it. Every other route in this audit accepts that token via `Authorization: Bearer …`. `whoami` also reports whether the caller is a methodologist, which the UI uses to gate locking, promotion, and other privileged buttons.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| POST | `/api/auth/login` | 200 | `ok`, `token`, `reviewer_id`, `mode` | Body `{reviewer_id}`. `mode: "optional"` — server is in non-strict auth. |
| GET | `/api/auth/whoami` | 200 | `mode`, `allowlist`, `reviewer_id`, `authenticated`, `is_methodologist` | Methodologist flag drives privileged UI. |

## 2. Patients & Tasks

The patient and task catalogs are read-mostly directories: who can be reviewed and what guidelines we have. `GET /api/tasks` is the index, and `GET /api/tasks/:id` is the canonical "give me everything about this guideline" call (criteria, time windows, fields, operational metadata). UI screens for picking a chart and selecting a guideline both lean on this trio.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/patients` | 200 | `[ patient_id, display_name, age, sex, index_date, headline, category, difficulty ]` | Array of 20 patient summaries. |
| GET | `/api/tasks` | 200 | `[ task_id, task_type, manual_version, field_count, final_output ]` | 2 tasks present (lung-cancer-phenotype, bbb). |
| GET | `/api/tasks/lung-cancer-phenotype` | 200 | `task_id`, `task_type`, `review_unit`, `manual_version`, `source_document_sha`, `index_anchor`, `time_windows`, `final_output`, `overview_prose`, `fields`, `operational` | The full guideline spec — fields list contains per-criterion schema. |

## 3. Reviews

A "review" is one reviewer's structured assessment of one patient against one guideline. The endpoint returns the live document including per-field assessments, evidence, summary, and cross-criterion alerts. This is the same shape the chart-review skill writes back via the MCP commit path.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/reviews/patient_easy_neg_01/lung-cancer-phenotype` | 200 | `schema_version`, `patient_id`, `task_id`, `task_version`, `task_document_sha`, `review_status`, `version`, `updated_at`, `updated_by`, `field_assessments`, `summary`, `cross_criterion_alerts`, `encounters` | One full review document. `field_assessments` carries per-field labels + evidence quotes. |

## 4. Pilots

Pilots are the methodologist-driven iteration loop on a draft guideline: each `iter_NNN` is a snapshot of the guideline at a SHA, the agent run executed against it, and the resulting accuracy summary. The list endpoint is the "iteration history" view, eligibility is the gate for promote-to-lock, and stats power the calibration dashboard.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/pilots/lung-cancer-phenotype` | 200 | `[ task_id, iter_id, iter_num, run_id, guideline_sha, started_at, started_by, state, notes, agent_specs, criterion_schema_hashes, rerun_plan, completed_at, run_status, n_complete, n_patients, critique, accuracy_summary ]` | One element per iteration. |
| GET | `/api/pilots/lung-cancer-phenotype/eligibility` | 200 | `eligible`, `consecutive_passing`, `required_consecutive`, `failing_criteria`, `override_growth` | Lock-readiness gate. |
| GET | `/api/pilots/lung-cancer-phenotype/stats` | 200 | `[ … ]` (per-criterion entries) | Array of per-criterion stat blocks. |

## 5. Runs

Runs are the unit of "the agent walked through N patients on this guideline at this SHA". The list view powers the run-picker; the per-run status view gives per-patient progress and totals — the polling target during a live run.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/runs?limit=3` | 200 | `[ run_id, task_id, state, started_at, n_patients, n_complete, n_error ]` | Returned 35 entries — `?limit=3` was apparently ignored. Client-side slicing recommended until verified server-side. |
| GET | `/api/runs/2026-05-03T10-52-42-581Z/status` | 200 | `run_id`, `state`, `started_at`, `updated_at`, `completed_at`, `total_cost_usd`, `n_patients`, `n_complete`, `n_error`, `n_running`, `per_patient` | Polling endpoint; `per_patient` carries per-row state for live UI. |

## 6. Cohorts (deployment-stage validation)

Cohorts represent post-lock deployment-stage QA: a frozen set of patients run against a locked guideline, then a smaller blind-validated sample with a κ report. The four endpoints span the whole deployment loop — list cohorts, pick one, draw or look up the validated sample, and pull the persisted κ report.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/cohorts` | 200 | `cohorts` | Single-key wrapper; underlying value is an array. |
| GET | `/api/cohorts/lung-cancer-smoke-test` | 200 | `manifest`, `runs` | Manifest = static cohort metadata; runs = chronological run history. |
| GET | `/api/cohorts/lung-cancer-smoke-test/runs/2026-05-03T10-52-42-581Z/sample` | 200 | `cohort_id`, `run_id`, `drawn_at`, `drawn_by`, `n_total`, `n_validated`, `patients` | The blind-sample selection + validation status. |
| GET | `/api/cohorts/lung-cancer-smoke-test/runs/2026-05-03T10-52-42-581Z/report` | 200 | `cohort_id`, `run_id`, `n_validated_patients`, `n_total_sampled`, `overall_kappa`, `overall_ci`, `per_criterion`, `computed_at` | Persisted deployment-κ report. |

## 7. Deployment issues

The deployment-issues queue is an append-only JSONL log per locked guideline SHA, fed by reviewers spotting field-level errors in production. The audit POSTed a synthetic issue then GET-verified it landed; the test row was then stripped from the underlying log file as cleanup. Note that on the first POST attempt, the documented `summary`/`details` field names from the bundle export are not what this endpoint accepts — required fields are `patient_id` and `description`. There is no DELETE route; the queue is intentionally append-only, with a separate triage endpoint for state changes.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| POST | `/api/deployment-issues/dc10f6f020cd49af` (wrong shape) | 400 | `error` | `{error: "patient_id and description are required"}` — surfaces the contract. |
| POST | `/api/deployment-issues/dc10f6f020cd49af` (correct) | 201 | `issue_id`, `guideline_sha`, `patient_id`, `reporter_id`, `reported_at`, `description` | Append wins; returns the persisted record. |
| GET | `/api/deployment-issues/dc10f6f020cd49af` | 200 | `guideline_sha`, `issues`, `n_total` | `issues[].triage` is rolled-up latest state from the log. |

## 8. Bundles (export)

Bundles are the "ship a locked guideline + everything around it" artifact: guideline text, rules, run/pilot history, deployment cohorts, issues queue, all wrapped into a directory and optional tarball. `?tarball=1` triggers tarball creation. Listing is a directory walk, POST creates a fresh bundle.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/exports/lung-cancer-phenotype` | 200 | `[ task_id, bundle_id, exported_at, exported_by, guideline_sha ]` | 24 prior bundles. |
| POST | `/api/exports/lung-cancer-phenotype?tarball=1` | 200 | `ok`, `bundle_dir`, `tarball_path`, `tarball_size`, `manifest` | `manifest.contents` enumerates bundled cohorts/issues/rules/etc. counts. |
| GET | `/api/exports/lung-cancer-phenotype` (after) | 200 | (same) | Count went from 24 to 25; cleanup later restored to 24. |

## 9. Calibration

Calibration is the pre-lock gate: blind dual-reviewer samples computing per-criterion Cohen's κ before promoting a draft to locked. The runs endpoint is the calibration history; archived κ reports live underneath.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/guideline-calibration/lung-cancer-phenotype/runs` | 200 | `[ run_id, archived_at ]` | Historical calibration runs. |

## 10. Rules / improvement

`rules` are the proposal-tracker for the chart-review-improve workflow — concrete machine-readable edits proposed against a guideline; `improvement/proposals` is a directory listing of the on-disk proposal YAML files. Together they let a methodologist see what the improvement skill has suggested.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/rules/lung-cancer-phenotype` | 200 | `[ id, guideline_id, created_at, created_by, target_field, change_kind, motivating_patients, evidence, proposal, rationale, provenance ]` | Per-rule proposal records. |
| GET | `/api/guideline-improvement/lung-cancer-phenotype/proposals` | 200 | `[ proposal_id, path, size_bytes, modified_at ]` | Filesystem listing of YAML proposals. |

## 11. Methods

Methods runs are the chart-review-methods skill's outputs — the academic-paper Methods-section drafts produced from a locked guideline plus QA stats. Each entry is a generated draft archived under the task.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/methods/lung-cancer-phenotype/runs` | 200 | `[ … ]` (empty in this task) | Returned `[]` for lung-cancer-phenotype — no methods drafts archived yet. |

## 12. Lock test

A dedicated namespace for the copilot-blind dual-agent disagreement run that the dual-agent MVP introduced. Each entry records the lock-test attempt, including the `copilot_blind_mode` flag and the linked agent run id.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/lock-test/lung-cancer-phenotype` | 200 | `[ task_id, run_id, guideline_sha, started_at, started_by, state, copilot_blind_mode, agent_run_id ]` | Returns array (1 entry on this task). |

## 13. Versions / maturity / SHA

These three endpoints give the methodologist a definitive "what state is this guideline in?" view: archived versions, the lifecycle state machine (draft → calibrated → locked → deployed), and the current canonical SHA used everywhere else for join keys.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/versions/lung-cancer-phenotype` | 200 | `[ task_id, lock_task_sha, archived_at, record_count ]` | Archive history. |
| GET | `/api/guidelines/lung-cancer-phenotype/maturity` | 200 | `task_id`, `state`, `transitions` | State machine + transition history. |
| GET | `/api/guidelines/lung-cancer-phenotype/sha` | 200 | `sha` | The canonical 16-hex SHA used as a join key throughout. |

## 14. Notifications

A simple inbox for reviewer-facing events. The list returned `[]` (clean inbox); the unread-count endpoint mirrors that with `count: 0`. The UI badge polls `unread-count` and falls back to the full list on click.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/notifications` | 200 | `[ … ]` (empty) | Empty array on this server. |
| GET | `/api/notifications/unread-count` | 200 | `count` | Lightweight badge endpoint. |

## 15. Runtime

A single read-only "what is this server configured with?" summary — used by the UI banner and by integration tests asserting environment shape.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/runtime` | 200 | `model`, `base_url`, `default_task_id`, `auth_mode`, `reviewers` | Returns model id, OpenAI-compatible base URL, default task, auth mode, allowlisted reviewers. |

## 16. Authoring drafts

The authoring drafts endpoint is the Studio Authoring tab's index: every in-progress guideline draft on disk, with metadata-only summary. Used by the chart-review-build skill's UI integration and the "resume an authoring session" picker.

| Method | Path | Status | Top-level keys | Notes |
|---|---|---|---|---|
| GET | `/api/authoring/drafts` | 200 | `[ task_id, path, field_count, has_meta, modified_at ]` | One row per draft directory. |

---

## Cleanup performed

- Deleted the synthetic deployment-issue (`AUDIT TEST - safe to delete`) by stripping its line from `deployment-issues/dc10f6f020cd49af.jsonl` (no DELETE route exists; the log is append-only by design).
- Deleted the test export bundle directory and tarball at `exports/lung-cancer-phenotype/2026-05-03T14-17-26-057Z{,.tar.gz}`.

Both side-effects were verified by re-running the corresponding GET endpoints — `n_total` returned to its pre-audit value and the bundle list dropped back to 24 entries.
