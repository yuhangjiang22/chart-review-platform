# Async Batch Runner — Design Spec

**Date**: 2026-04-29
**Status**: Approved (brainstorm output)
**Related**:
- `docs/methodology/staged-implementation-plan.md` — Phase 1 Task 3 (this work) and Task 4 (the reference skill that consumes the agent interface)
- `docs/superpowers/specs/2026-04-29-synthetic-patient-corpus-design.md` — the corpus this runner targets
- `chart-review-platform/contracts/review_record.schema.json` — the shape every agent must produce
- `chart-review-platform/lib/chart_review/corpus.py` — filesystem helpers the runner uses

---

## Goal

Add a new `chart-review batch` CLI subcommand that runs an agent against many patients in parallel and writes per-patient `ReviewRecord` JSON files plus a run-level summary. The runner is the substrate that future agents (Phase 1 Task 4's `extract-lab-value`, Phase 3's calibration pilots, Phase 4's nightly scheduler) plug into.

Phase 1 exit criterion: process all 20 corpus patients in parallel; total wall time < 5 min.

---

## Architecture

```
compiled_task.json + patient_ids + agent_entrypoint
        │
        ▼
ThreadPoolExecutor (max_workers = --concurrency, default 5)
        │
        ▼  (one task per patient)
agent.run(compiled_task, corpus_root, patient_id) → ReviewRecord
        │
        ▼  (per worker, on return)
write runs/<run_id>/<patient_id>.json
        │
        ▼  (after all workers complete)
write runs/<run_id>/summary.json
        │
        ▼
print summary table to stdout
```

Threading is the right primitive because real agents (starting with Task 4) are dominated by network round-trips to Claude. Async-def would force an awkward signature on agent authors; multiprocessing would add pickling overhead with no payoff for I/O-bound work.

---

## Agent interface

A pluggable Python entrypoint identified by `module:function`:

```python
def run(
    compiled_task: dict,
    corpus_root: Path,
    patient_id: str,
) -> dict:
    """Produce a ReviewRecord for one patient.

    Inputs:
      compiled_task — fully resolved CompiledTask dict (validated upstream).
      corpus_root   — path to the corpus directory; agents typically use
                      chart_review.corpus helpers (read_note, grep_notes,
                      omop_query) to access patient data.
      patient_id    — the patient to assess.

    Returns:
      A dict matching contracts/review_record.schema.json. The runner
      does NOT validate the return value — chain `chart-review validate-record`
      on the output if you need that.

    Raises:
      Anything. The runner catches exceptions and marks the patient's
      row in the summary as status='error'; other workers continue.
    """
```

The runner imports the entrypoint lazily (`importlib.import_module(module).<function>`) the first time it's needed. Failure to import aborts the whole run before any work starts.

---

## CLI

```
chart-review batch <compiled_task.json>
    [--patients <comma-list>]
    [--patients-file <path>]
    [--all]
    [--corpus-root <path>]              (default: corpus)
    [--agent <module:function>]         (default: chart_review.agents.stub:run)
    [--concurrency <int>]               (default: 5)
    [--run-id <name>]                   (default: ISO timestamp, e.g. 2026-04-29T22-15-00Z)
    [--output-dir <path>]               (default: runs)
    [--force-overwrite]                 (overwrite an existing run dir)
    [--validate]                        (validate each ReviewRecord before writing)
```

Patient selection is mutually exclusive: exactly one of `--patients`, `--patients-file`, or `--all` is required (no default — explicit selection prevents surprises).

**Examples:**

```sh
chart-review batch build/compiled_task.json --all
chart-review batch build/compiled_task.json --patients patient_neg_hard_01,patient_easy_nsclc_01
chart-review batch build/compiled_task.json --all --agent chart_review.agents.stub:run --concurrency 8
```

---

## Output shapes

### `runs/<run_id>/<patient_id>.json`

Raw `ReviewRecord` returned by the agent. Validates against `contracts/review_record.schema.json` if `--validate` was passed.

### `runs/<run_id>/summary.json`

```json
{
  "run_id": "2026-04-29T22-15-00Z",
  "started_at": "2026-04-29T22:15:00.123Z",
  "completed_at": "2026-04-29T22:18:42.847Z",
  "agent_entrypoint": "chart_review.agents.stub:run",
  "compiled_task_sha": "sha256:e8ede1cf…",
  "concurrency": 5,
  "patients": [
    {
      "patient_id": "patient_neg_hard_01",
      "status": "ok",
      "duration_ms": 12,
      "output_path": "runs/2026-04-29T22-15-00Z/patient_neg_hard_01.json"
    },
    {
      "patient_id": "patient_easy_nsclc_03",
      "status": "error",
      "duration_ms": 4,
      "error": "ValueError: agent could not parse note 2024-07-21__surgical_pathology.txt"
    }
  ]
}
```

`compiled_task_sha` is read directly off the compiled task's `source_document_sha` field — it ties a run to a specific protocol version.

---

## Error handling

| Scenario | Behavior |
|---|---|
| Agent entrypoint can't be imported | Run aborts before the executor starts; non-zero exit code. |
| Patient ID not found in corpus | Run aborts before the executor starts; lists missing IDs. |
| Output dir already exists for the same `run_id` | Run aborts unless `--force-overwrite` is passed. |
| Agent raises an exception | Worker catches; logs `{status: "error", error: "<class>: <message>"}` for that patient; per-patient JSON is NOT written; other workers continue. |
| Agent returns a non-dict | Treated as `error` (worker catches `TypeError` from JSON dump). |
| Agent returns invalid ReviewRecord (and `--validate` is set) | Treated as `error`; record-not-written. |
| Agent returns invalid ReviewRecord (and `--validate` is unset) | JSON written as-is; downstream `validate-record` will catch. |

The runner exits 0 if all patients succeeded, 1 if any patient errored. The summary always lands; even a fully-failed run produces a `summary.json`.

---

## Stub agent — `chart_review.agents.stub:run`

Returns a minimal-valid ReviewRecord with one assessment per leaf field, every answer set to `"no_info"`, empty evidence, low confidence:

```python
def run(compiled_task, corpus_root, patient_id):
    leaves = [f for f in compiled_task["fields"] if "derivation" not in f]
    started = datetime.now(timezone.utc).isoformat()
    return {
        "record_id": f"stub_{patient_id}_{int(time.time()*1000)}",
        "task_document_sha": compiled_task["source_document_sha"],
        "review_unit_id": patient_id,
        "patient_id": patient_id,
        "task_metadata_snapshot": {
            "task_id": compiled_task.get("task_id"),
            "manual_version": compiled_task.get("manual_version"),
        },
        "started_at": started,
        "completed_at": started,
        "criterion_assessments": [
            {
                "field_id": f["id"],
                "answer": "no_info",
                "evidence": [],
                "confidence": "low",
                "missingness_reason": "not_assessed",
            }
            for f in leaves
        ],
    }
```

Two purposes:
1. End-to-end smoke test of the runner without needing real agent infrastructure.
2. A floor agent for benchmarking. When Task 4's `extract-lab-value` agent produces ReviewRecords scoring better than the stub on the corpus, that's the minimum bar.

---

## Testing

`lib/tests/test_batch.py`:

1. **`test_batch_against_fake_corpus_succeeds`** — build a 2-patient corpus in `tmp_path`, run `run_batch` with the stub agent, assert: 2 per-patient JSON files exist; `summary.json` lists both patients with `status="ok"`; `summary["run_id"]` matches the requested run-id; `compiled_task_sha` matches the input.
2. **`test_batch_handles_agent_exception`** — register a fake agent that raises `ValueError("boom")`; assert: per-patient JSON is NOT written; `summary["patients"][i]["status"] == "error"`; the error message includes `"boom"`; the runner returns a non-zero exit code.
3. **`test_batch_aborts_on_missing_patient`** — pass `--patients patient_does_not_exist`; assert non-zero exit code, no executor started, no files written.
4. **`test_batch_aborts_on_existing_run_dir`** — pre-create the run dir; assert exit code 1 with a clear message; pass `--force-overwrite`; assert the run proceeds.
5. **`test_batch_validates_when_flag_set`** — register a fake agent that returns a malformed dict; with `--validate`, the patient is marked `error`; without `--validate`, the patient is `ok` and the bad JSON is on disk.
6. **`test_batch_against_hand_crafted_patients`** — run the stub agent against the real 5 hand-crafted patients in `corpus/patients/`. Assert: 5 per-patient files; total wall time < 30 seconds; all `status="ok"`. (No real agent here — just verifies the runner integrates with the actual corpus.)

---

## Out of scope for this work

- Per-agent scoring / accuracy metrics. Computing how well an agent did vs. ground-truth is a separate command (`chart-review score <run_id>`) that lands in Phase 3 alongside the calibration view.
- Faithfulness checking on agent output. Already exists as `chart-review faithfulness`; the user chains it.
- Derivation evaluation on agent output. Already exists as `chart-review derive`; the user chains it.
- Resume / retry semantics. Re-running with the same `run_id` aborts unless `--force-overwrite`. Smarter retry policies wait for Phase 4.
- Per-skill cost / token tracking. Phase 4 (when QA dashboard arrives).
- A `stub_ground_truth` reference agent that mirrors `ground_truth.json`. Useful for calibration, but not for testing the runner; deferred to Phase 3.
- Live progress UI (a TUI / browser progress page). The summary table on stdout at the end is enough; users can `tail` `runs/<run_id>/` to monitor.
- Cross-run comparison. The summary's deterministic shape makes future analytics easy, but a `chart-review compare-runs` command isn't part of Task 3.

---

## Open questions

These are not yet decided and should drive small follow-ups:

1. **Should the runner inject `os.environ["CORPUS_ROOT"]`** or pass `corpus_root` only via the function call? Current proposal: function call only. Agents that genuinely need an env var can read it themselves; we don't need to fork the contract over this.

2. **Should we fail fast on the first error**, or always run to completion? Current proposal: always complete (collect all errors, exit non-zero). Fail-fast is opinionated; a `--fail-fast` flag could be added later if calibration users want it.

3. **Should the run dir be sharded** (`runs/2026-04/29/<run_id>/`) for ergonomics once thousands of runs accumulate? Defer — flat layout is fine for Phase 1's scale.

4. **Should the stub agent live in `chart_review.agents.stub` or `chart_review.batch.stub`?** Current proposal: `chart_review.agents.stub`. The `agents/` package is the natural home for plugin entrypoints; future agents (`chart_review.agents.extract_lab_value`, real institution adapters, etc.) all live there.
