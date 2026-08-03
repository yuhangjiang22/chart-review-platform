# scripts/

Developer tooling — none of this ships in a deployment; it's for running,
testing, and validating the platform locally.

| Path | What it is |
|---|---|
| `_dev-up.sh` / `_dev-down.sh` | Start / stop the local dev stack (API :3002, Vite :5174, NER proxy :18080) detached. |
| `run-bso-ad-claude-sdk.ts` | NER-SDK per-note run driver — **spawned by the server** (`ner-sdk-run-routes.ts`); do not move. |
| `convert-ad-cde-to-concepts.mjs` | One-off: convert an AD-CDE table into an ontology `concepts.json`. |
| `qa/` | End-to-end QA drivers (`qa-phenotype-*`, `qa-lung-adherence-e2e`) — drive the real backend through a full workflow. |
| `smoke/` | Fast smoke checks (`smoke-*-run`, `assert-light-task`) — quick "does it run" gates. |
| `deploy/` | Headless run / provider-comparison drivers (`run-adherence-claude`, `run-provider-compare`, `pernote-live-e2e`, `lung-refine-demo`). |
| `e2e/` | `doctor.ts` — repo/state health checks (cohort scoping, stale citations). |
| `lib/` | Shared helpers imported by the run drivers (`run-benchmark-cohort`, `benchmark-ner-map`). |
| `rucam-realtest/` | RUCAM real-data validation harness (setup / run / validate vs human gold). |
| `lung-realtest/` | Lung-adherence real-data materialize + run harness. |
| `asthma-sql-script/` | OMOP ETL + cohort SQL for the asthma-adherence data pull. |

Most drivers take an OpenAI-compatible `--endpoint` + `--model` and read the
active skill from `.claude/skills/`. See each file's header comment for usage.
