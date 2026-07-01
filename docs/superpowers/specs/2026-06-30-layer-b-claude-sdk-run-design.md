# Layer B — run the Claude Agent SDK benchmark from the bso-ad-ner NER tab

**Date:** 2026-06-30
**Status:** design — approved in brainstorming, not yet implemented
**Scope:** bso-ad-ner ONLY. Make the platform actually RUN the benchmark's Claude-Agent-SDK + gpt-5.2 NER pipeline over an existing session's cohort, landing results as a reviewable NER iteration. Follow-on to the C+A work (`2026-06-30-benchmark-ner-into-platform-design.md`), which this reuses.

> **STANDING INSTRUCTION — DO NOT COMMIT.** All changes stay local.

## Why / what

Today the platform's only agent provider is `deepagents` (LangChain/LangGraph → gpt-5.2 via `langchain_openai`). It does NOT run the benchmark's Claude Agent SDK harness. Layer B adds a **dedicated, bso-ad-ner-only path** that shells out to the benchmark's per-note CLI (Claude Agent SDK + the benchmark's MCP server + gpt-5.2 via the Azure proxy) and materializes the output into the platform's NER review surface.

Key realization: **Layer B ≈ Layer A with the data source swapped** — instead of reading a pre-existing `predictions.json`, we generate per-note predictions by running the benchmark CLI, then reuse Layer A's pure mapping (`buildSpanLabel` / `buildReviewState`) and session-scoped `writeReviewState` to land them.

## Explicit non-goals (owner direction, 2026-06-30)

- **No platform `agent-provider` integration.** The benchmark pipeline is one fixed flow; it has none of the platform's `agent_specs` / role-preset / `search_mode` × `interpretation` / multi-agent-disagreement concepts. We do NOT add a `ProviderName`, and the existing TRY button / provider abstraction is untouched.
- **No "start a new session" dialog.** That dialog configures agent roles — irrelevant here. We reuse an existing session's cohort (created programmatically, as Layer A's import already does).
- **No changes to other tasks or to platform server core** beyond, at most, registering one new bso-ad-ner-scoped route in the optional follow-on. The MVP is script-only.
- **No live event streaming** into the TRY UI. Batch-run, then results appear in the NER VALIDATE tab on refresh.

## Decisions (locked in brainstorming)

1. **Interface:** a CLI script is the primary "interface" (`scripts/run-bso-ad-claude-sdk.ts`). A thin HTTP endpoint is a deferred follow-on, not part of the MVP.
2. **Run mode:** batch — run every cohort note, then write `review_state`.
3. **Input:** an existing `session_id`; read its `cohort.patient_ids`, run the benchmark over each patient's `notes/*.txt`.

## Verified facts (2026-06-30)

- Benchmark per-note CLI (subcommand `ner`):
  ```
  python3 run_benchmark.py ner \
    --note-id <id> --person-id <pid> --text-file <abs note path> \
    --data-root <dir with concepts.json> --output-root <scratch dir> --model <model>
  ```
  Writes `<output-root>/<sanitized note_id>.json` = `{note_id, person_id, model, entities:[{text,start,end,entity_type,concept_name,status,match_kind,…}], skill_version, ontology_version}`.
- `claude_agent_sdk` is importable from the system `python3` (Python 3.14 user site-packages) — no venv needed.
- The benchmark needs `ANTHROPIC_BASE_URL` (Azure proxy, default :18080) + an API key (or `AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_API_KEY` it folds into `ANTHROPIC_API_KEY`). These live in `<BENCHMARK_ROOT>/.env`. The proxy must be running.
- Benchmark ontology dir = `<BENCHMARK_ROOT>/ontology/` (contains `concepts.json`; identical concept set to the platform's synced copy after Layer C).
- Platform: `getSessionManifest(taskId, sessionId)` / `listSessions` (`@chart-review/domain-iter`) give `cohort.patient_ids`. `listNotes(patientId)` / `patientDir` (`@chart-review/patients`) give note filenames; `note_id` = filename without `.txt`. `readPatientMeta`/meta.json carries `person_id` (written by Layer A's import).
- Reuse from Layer A (`scripts/lib/benchmark-ner-map.ts`): `buildSpanLabel`, `buildReviewState`, `assertOffsetsFaithful`, `BenchEntity`. Reuse Layer A's session-scoped write pattern: `withReviewsRoot(path.join(reviewsRoot, sessionId), () => writeReviewState(patientId, "bso-ad-ner", state))`.
- Task id is the bare `bso-ad-ner` (no `chart-review-` prefix), per the C+A work.

## Architecture

```
CLI: scripts/run-bso-ad-claude-sdk.ts  --session-id <id>  [--model gpt-5.2]
        │  reads session cohort (getSessionManifest)
        ▼
core: scripts/lib/run-benchmark-cohort.ts
        runBenchmarkCohort({ sessionId, model, onProgress })
          for each patientId in cohort.patient_ids:
            person_id ← meta.json.person_id  (fallback: patientId minus "patient_real_")
            for each note file in corpus/patients/<patientId>/notes/*.txt:
              args   ← buildBenchmarkArgs({ noteId, personId, noteFile, dataRoot, outRoot, model })
              spawn  ← python3 run_benchmark.py ner …   (cwd=BENCHMARK_ROOT, env=baseEnv⊕parseEnvFile(.env))
              json   ← read <outRoot>/<noteId>.json
              spans  ← json.entities.map(e => buildSpanLabel(noteId, e))
              assertOffsetsFaithful(noteText, spans, noteId)
            state  ← buildReviewState(patientId, "bso-ad-ner", allSpansForPatient, nowIso, ontologyPin)
            withReviewsRoot(<reviewsRoot>/<sessionId>) → writeReviewState(patientId, "bso-ad-ner", state)
        ▼
NER tab → VALIDATE (reads review_state, unchanged)
```

### Component responsibilities (each independently testable)

`scripts/lib/run-benchmark-cohort.ts`:
- `parseEnvFile(path): Record<string,string>` — minimal `KEY=value` parser (skip comments/blanks, strip quotes). **Pure.**
- `buildBenchmarkArgs(input): string[]` — assemble the `run_benchmark.py ner …` argv. **Pure.**
- `runOneNote(input): Promise<BenchNoteResult>` — spawn the CLI (async), read the output JSON; on non-zero exit or missing output, return `{ ok:false, error }`. Side-effecting, integration-tested.
- `runBenchmarkCohort({sessionId, model, onProgress}): Promise<CohortRunSummary>` — orchestrate the loops, build + write `review_state` per patient, return `{ patients:[{patientId, n_notes, n_spans, failures[]}], …}`. Side-effecting.

`scripts/run-bso-ad-claude-sdk.ts`:
- Arg parse (`--session-id` required, `--model` default `gpt-5.2`, `--benchmark-root` default `../claude-agent-sdk-benchmark`), preflight checks, call `runBenchmarkCohort`, print summary.

### Configuration / env
- `BENCHMARK_ROOT` (default `<PLATFORM_ROOT>/../claude-agent-sdk-benchmark`).
- Benchmark env injected into the subprocess from `parseEnvFile(<BENCHMARK_ROOT>/.env)` merged over `process.env`. (We do NOT require the platform's own shell to carry `ANTHROPIC_*`.)
- `--data-root` = `<BENCHMARK_ROOT>/ontology`. `--output-root` = a scratch dir under the platform (e.g. `var/benchmark-sdk/<sessionId>/`), gitignored via `var/`.
- `--person-id` from the patient's `meta.json`; fallback = `patientId` with the `patient_real_` prefix stripped.

### Preflight (fail fast, clear messages)
1. `BENCHMARK_ROOT` + `run_benchmark.py` + `ontology/concepts.json` exist → else BLOCKED message naming the missing path.
2. Azure proxy reachable (`ANTHROPIC_BASE_URL` resolved from benchmark .env; a quick TCP/HTTP check to :18080) → else clear "start the proxy first".
3. The session exists and has a non-empty cohort.

### Error handling
- Each note runs in its own try/catch; a failed note is recorded in `failures[]` (with stderr tail) and skipped — the batch continues.
- A patient with zero successful notes still gets a `review_state` written (empty `span_labels`) so its status is visible, OR is reported as failed — **decision: write empty + record failure**, so the cohort's review surface is complete and the gap is visible.
- Offset-faithfulness violations (`assertOffsetsFaithful`) abort that note only, recorded as a failure (means the benchmark's note text and the platform's note file diverged — should not happen when the cohort came from Layer A's verbatim import).

## Testing

- **Unit (vitest):** `parseEnvFile` (comments/quotes/blank lines), `buildBenchmarkArgs` (exact argv incl. paths + model). These are the pure cores.
- **Integration (manual / scripted):** with the Azure proxy up, run `scripts/run-bso-ad-claude-sdk.ts --session-id session_003` against the 5 imported patients; assert each gets a refreshed `review_state` with spans, failures summary printed, PHI containment (`git status` clean of `patient_real_*`/`var/`). A reviewer opens the NER tab and sees the freshly-run spans.
- **Determinism caveat (documented, not a bug):** re-running yields similar-but-not-identical spans — the pipeline is a non-deterministic multi-turn LLM agent.

## Deferred follow-on (not in this spec's MVP)

`POST /api/bso-ad-ner/run-claude-sdk` (+ `GET …/status`) — a thin route that launches `runBenchmarkCohort` as a background job and returns immediately, so a button in the NER tab can trigger it. Adds one bso-ad-ner-scoped route file + one registration line; no other-task or provider changes. Implement only if a UI trigger is wanted after the CLI proves out.

## Self-review

- Placeholders: none — invocation, output shape, env, paths, reused functions all concrete.
- Consistency: task id `bso-ad-ner`, session-scoped `withReviewsRoot`, and the Layer-A reuse match the C+A spec/impl.
- Scope: single focused deliverable (CLI + core lib); endpoint explicitly deferred; non-goals fence off provider/other-task changes.
- Ambiguity: zero-success-patient behavior resolved (write empty + record failure); person_id source + fallback specified.
