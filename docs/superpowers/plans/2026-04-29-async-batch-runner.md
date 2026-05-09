# Async Batch Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `chart-review batch` CLI subcommand that runs a Python-entrypoint agent against many patients in parallel via ThreadPoolExecutor, writing per-patient ReviewRecord JSON + a run-level summary.json.

**Architecture:** New module `chart_review.batch` orchestrates; new package `chart_review.agents` ships a `stub_no_info` reference agent. The agent contract is a callable `run(compiled_task, corpus_root, patient_id) -> dict` identified by a `module:function` entrypoint string. Output lands under `runs/<run_id>/`.

**Tech Stack:** Python 3.12 stdlib only (`concurrent.futures.ThreadPoolExecutor`, `importlib`, `pathlib`, `argparse`, `datetime`, `json`). Tests via pytest + tmp_path.

---

## File structure

| Path | Responsibility |
|---|---|
| `chart-review-platform/lib/chart_review/batch.py` (new, ~140 lines) | `run_batch()` function: dispatch, error capture, write outputs. |
| `chart-review-platform/lib/chart_review/agents/__init__.py` (new, empty) | Package marker. |
| `chart-review-platform/lib/chart_review/agents/stub.py` (new, ~40 lines) | `run()` — minimal-valid ReviewRecord. |
| `chart-review-platform/lib/chart_review/cli.py` (modify) | Add `batch` subcommand wiring. |
| `chart-review-platform/lib/tests/test_agent_stub.py` (new) | Verify stub output validates against the schema. |
| `chart-review-platform/lib/tests/test_batch.py` (new) | 6 tests covering happy path / agent exceptions / missing patients / existing run dir / `--validate` / real corpus integration. |
| `chart-review-platform/.gitignore` (new or modify) | Exclude `runs/`. |

---

## Task 1: `chart_review.agents.stub` reference agent

**Files:**
- Create: `chart-review-platform/lib/chart_review/agents/__init__.py`
- Create: `chart-review-platform/lib/chart_review/agents/stub.py`
- Create: `chart-review-platform/lib/tests/test_agent_stub.py`

- [ ] **Step 1: Write the failing test**

Create `chart-review-platform/lib/tests/test_agent_stub.py`:

```python
"""Verify the stub_no_info agent returns a ReviewRecord that validates
against the canonical schema."""

from __future__ import annotations

import json
from pathlib import Path

from chart_review.agents.stub import run as stub_run
from chart_review.validator import validate_review_record

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"


def _compiled_task() -> dict:
    return json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())


def test_stub_returns_dict():
    record = stub_run(_compiled_task(), ROOT / "corpus", "patient_neg_hard_01")
    assert isinstance(record, dict)


def test_stub_record_validates():
    record = stub_run(_compiled_task(), ROOT / "corpus", "patient_neg_hard_01")
    result = validate_review_record(record, CONTRACTS)
    assert result["status"] == "pass", result["errors"]


def test_stub_emits_one_assessment_per_leaf_field():
    compiled = _compiled_task()
    leaves = [f for f in compiled["fields"] if "derivation" not in f]
    record = stub_run(compiled, ROOT / "corpus", "patient_neg_hard_01")
    assert len(record["criterion_assessments"]) == len(leaves)
    leaf_ids = {f["id"] for f in leaves}
    record_ids = {a["field_id"] for a in record["criterion_assessments"]}
    assert leaf_ids == record_ids


def test_stub_uses_no_info_for_every_answer():
    record = stub_run(_compiled_task(), ROOT / "corpus", "patient_neg_hard_01")
    for a in record["criterion_assessments"]:
        assert a["answer"] == "no_info"
        assert a["confidence"] == "low"
        assert a["evidence"] == []


def test_stub_record_id_is_patient_specific():
    r1 = stub_run(_compiled_task(), ROOT / "corpus", "patient_a")
    r2 = stub_run(_compiled_task(), ROOT / "corpus", "patient_b")
    assert "patient_a" in r1["record_id"]
    assert "patient_b" in r2["record_id"]
    assert r1["record_id"] != r2["record_id"]
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
chflags -R nohidden ../.venv/lib 2>/dev/null
source ../.venv/bin/activate
python3 -m pytest tests/test_agent_stub.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chart_review.agents'`.

- [ ] **Step 3: Create the agents package**

```sh
mkdir -p "Studies/Chart Review Agents/chart-review-platform/lib/chart_review/agents"
touch "Studies/Chart Review Agents/chart-review-platform/lib/chart_review/agents/__init__.py"
```

The `__init__.py` is intentionally empty; the package exists only as a namespace for plug-in agents (`chart_review.agents.stub`, future `chart_review.agents.extract_lab_value`, etc.).

- [ ] **Step 4: Implement `chart_review/agents/stub.py`**

Write `chart-review-platform/lib/chart_review/agents/stub.py`:

```python
"""Stub_no_info reference agent.

Returns a minimum-valid ReviewRecord with one assessment per leaf field,
every answer set to 'no_info', empty evidence, low confidence. Two
purposes:

- End-to-end smoke test of chart_review.batch without needing real
  agent infrastructure (no API calls, no skills, no tool adapters).
- Floor agent for benchmarking. Real agents (Phase 1 Task 4 and later)
  produce ReviewRecords that should score better than this floor.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path


def run(
    compiled_task: dict,
    corpus_root: Path,
    patient_id: str,
) -> dict:
    """Produce a ReviewRecord with `no_info` for every leaf field."""
    leaves = [f for f in compiled_task["fields"] if "derivation" not in f]
    started_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    record_id = f"stub_{patient_id}_{int(time.time() * 1000)}"
    return {
        "record_id": record_id,
        "task_document_sha": compiled_task["source_document_sha"],
        "review_unit_id": patient_id,
        "patient_id": patient_id,
        "task_metadata_snapshot": {
            "task_id": compiled_task.get("task_id"),
            "manual_version": compiled_task.get("manual_version"),
        },
        "started_at": started_at,
        "completed_at": started_at,
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

- [ ] **Step 5: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_agent_stub.py -v
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/lib/chart_review/agents chart-review-platform/lib/tests/test_agent_stub.py
git commit -m "Add chart_review.agents.stub reference agent

Stub_no_info agent returns the minimum-valid ReviewRecord (one
assessment per leaf field with answer='no_info', empty evidence,
low confidence). Used as the end-to-end smoke target for the batch
runner and as the floor agent for future benchmarking."
```

---

## Task 2: `chart_review.batch.run_batch` orchestration

**Files:**
- Create: `chart-review-platform/lib/chart_review/batch.py`
- Create: `chart-review-platform/lib/tests/test_batch.py`

- [ ] **Step 1: Write the failing tests**

Create `chart-review-platform/lib/tests/test_batch.py`:

```python
"""Tests for chart_review.batch — orchestration of per-patient agent runs."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

from chart_review.batch import run_batch

ROOT = Path(__file__).resolve().parents[2]


def _compiled_task() -> dict:
    return json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())


def _build_fake_corpus(tmp_path: Path, patient_ids: list[str]) -> Path:
    """Build a minimal corpus tree for testing."""
    for pid in patient_ids:
        d = tmp_path / "patients" / pid
        (d / "notes").mkdir(parents=True)
        (d / "omop").mkdir()
        (d / "meta.json").write_text(json.dumps({
            "patient_id": pid,
            "category": "negative",
            "demographics": {"age": 50, "sex": "F"},
            "index_date": "2025-01-01",
            "doc_types": [],
            "generated_by": "hand",
        }))
    return tmp_path


def _register_fake_agent(name: str, run_fn) -> str:
    """Register a fake agent module on sys.modules and return its entrypoint."""
    mod_name = f"chart_review_test_agents_{name}"
    mod = types.ModuleType(mod_name)
    mod.run = run_fn
    sys.modules[mod_name] = mod
    return f"{mod_name}:run"


# ---- Test 1: happy path ----

def test_batch_against_fake_corpus_succeeds(tmp_path):
    corpus = _build_fake_corpus(tmp_path / "corpus", ["patient_a", "patient_b"])
    output_dir = tmp_path / "runs"

    summary = run_batch(
        compiled_task=_compiled_task(),
        corpus_root=corpus,
        patient_ids=["patient_a", "patient_b"],
        agent_entrypoint="chart_review.agents.stub:run",
        concurrency=2,
        run_id="test_run_01",
        output_dir=output_dir,
    )

    assert (output_dir / "test_run_01" / "patient_a.json").is_file()
    assert (output_dir / "test_run_01" / "patient_b.json").is_file()
    assert (output_dir / "test_run_01" / "summary.json").is_file()
    assert summary["run_id"] == "test_run_01"
    assert summary["agent_entrypoint"] == "chart_review.agents.stub:run"
    assert summary["compiled_task_sha"] == _compiled_task()["source_document_sha"]
    assert {p["patient_id"] for p in summary["patients"]} == {"patient_a", "patient_b"}
    for p in summary["patients"]:
        assert p["status"] == "ok"
        assert p["duration_ms"] >= 0
        assert "output_path" in p


# ---- Test 2: agent exception ----

def test_batch_handles_agent_exception(tmp_path):
    corpus = _build_fake_corpus(tmp_path / "corpus", ["patient_a"])

    def boom_agent(compiled_task, corpus_root, patient_id):
        raise ValueError("boom")

    entry = _register_fake_agent("boom", boom_agent)

    summary = run_batch(
        compiled_task=_compiled_task(),
        corpus_root=corpus,
        patient_ids=["patient_a"],
        agent_entrypoint=entry,
        concurrency=1,
        run_id="test_run_02",
        output_dir=tmp_path / "runs",
    )

    p = summary["patients"][0]
    assert p["status"] == "error"
    assert "boom" in p["error"]
    assert "ValueError" in p["error"]
    # Per-patient JSON must NOT be written on error
    assert not (tmp_path / "runs" / "test_run_02" / "patient_a.json").exists()


# ---- Test 3: missing patient ----

def test_batch_aborts_on_missing_patient(tmp_path):
    corpus = _build_fake_corpus(tmp_path / "corpus", ["patient_a"])
    with pytest.raises(FileNotFoundError) as exc_info:
        run_batch(
            compiled_task=_compiled_task(),
            corpus_root=corpus,
            patient_ids=["patient_does_not_exist"],
            agent_entrypoint="chart_review.agents.stub:run",
            concurrency=1,
            run_id="test_run_03",
            output_dir=tmp_path / "runs",
        )
    assert "patient_does_not_exist" in str(exc_info.value)


# ---- Test 4: existing run dir ----

def test_batch_aborts_on_existing_run_dir(tmp_path):
    corpus = _build_fake_corpus(tmp_path / "corpus", ["patient_a"])
    (tmp_path / "runs" / "test_run_04").mkdir(parents=True)

    with pytest.raises(FileExistsError):
        run_batch(
            compiled_task=_compiled_task(),
            corpus_root=corpus,
            patient_ids=["patient_a"],
            agent_entrypoint="chart_review.agents.stub:run",
            concurrency=1,
            run_id="test_run_04",
            output_dir=tmp_path / "runs",
        )

    # With --force-overwrite (force=True), it proceeds
    summary = run_batch(
        compiled_task=_compiled_task(),
        corpus_root=corpus,
        patient_ids=["patient_a"],
        agent_entrypoint="chart_review.agents.stub:run",
        concurrency=1,
        run_id="test_run_04",
        output_dir=tmp_path / "runs",
        force_overwrite=True,
    )
    assert summary["patients"][0]["status"] == "ok"


# ---- Test 5: invalid entrypoint ----

def test_batch_aborts_on_unimportable_agent(tmp_path):
    corpus = _build_fake_corpus(tmp_path / "corpus", ["patient_a"])
    with pytest.raises(ImportError):
        run_batch(
            compiled_task=_compiled_task(),
            corpus_root=corpus,
            patient_ids=["patient_a"],
            agent_entrypoint="chart_review.does_not_exist:run",
            concurrency=1,
            run_id="test_run_05",
            output_dir=tmp_path / "runs",
        )
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_batch.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chart_review.batch'`.

- [ ] **Step 3: Implement `chart_review/batch.py`**

Write `chart-review-platform/lib/chart_review/batch.py`:

```python
"""Async batch runner for the chart-review platform.

run_batch dispatches one worker thread per patient, invokes the configured
agent entrypoint, and writes per-patient ReviewRecord JSON + a run-level
summary.json. The agent contract is a callable
`run(compiled_task, corpus_root, patient_id) -> dict`.
"""

from __future__ import annotations

import importlib
import json
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


def _resolve_agent(entrypoint: str) -> Callable:
    """Import the agent entrypoint string '<module>:<function>'.

    Raises ImportError if the module or function cannot be loaded.
    """
    if ":" not in entrypoint:
        raise ImportError(
            f"agent entrypoint must be 'module:function', got {entrypoint!r}"
        )
    module_name, func_name = entrypoint.split(":", 1)
    module = importlib.import_module(module_name)
    if not hasattr(module, func_name):
        raise ImportError(f"{module_name} has no attribute {func_name!r}")
    return getattr(module, func_name)


def _check_patients_exist(corpus_root: Path, patient_ids: list[str]) -> None:
    missing = [
        pid for pid in patient_ids
        if not (corpus_root / "patients" / pid).is_dir()
    ]
    if missing:
        raise FileNotFoundError(
            f"Patient(s) not found in corpus: {', '.join(missing)}"
        )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _run_one(
    agent: Callable,
    compiled_task: dict,
    corpus_root: Path,
    patient_id: str,
    run_dir: Path,
) -> dict:
    """Run the agent on one patient. Returns a summary entry dict."""
    started_ms = time.time() * 1000
    try:
        record = agent(compiled_task, corpus_root, patient_id)
        if not isinstance(record, dict):
            raise TypeError(
                f"agent returned {type(record).__name__}, expected dict"
            )
        out_path = run_dir / f"{patient_id}.json"
        out_path.write_text(json.dumps(record, indent=2) + "\n")
        return {
            "patient_id": patient_id,
            "status": "ok",
            "duration_ms": int(time.time() * 1000 - started_ms),
            "output_path": str(out_path.relative_to(run_dir.parent.parent))
                if run_dir.parent.parent in out_path.parents
                else str(out_path),
        }
    except Exception as e:
        return {
            "patient_id": patient_id,
            "status": "error",
            "duration_ms": int(time.time() * 1000 - started_ms),
            "error": f"{type(e).__name__}: {e}",
        }


def run_batch(
    *,
    compiled_task: dict,
    corpus_root: Path,
    patient_ids: list[str],
    agent_entrypoint: str,
    concurrency: int,
    run_id: str,
    output_dir: Path,
    force_overwrite: bool = False,
) -> dict[str, Any]:
    """Run an agent across many patients in parallel.

    Returns the summary dict that was written to summary.json.

    Raises:
      ImportError if the agent entrypoint is invalid.
      FileNotFoundError if any patient_id is missing from the corpus.
      FileExistsError if the run directory already exists and force_overwrite is False.
    """
    agent = _resolve_agent(agent_entrypoint)
    _check_patients_exist(corpus_root, patient_ids)

    run_dir = Path(output_dir) / run_id
    if run_dir.exists() and not force_overwrite:
        raise FileExistsError(
            f"Run directory already exists: {run_dir}. "
            f"Pass force_overwrite=True (or --force-overwrite) to replace it."
        )
    if run_dir.exists() and force_overwrite:
        for child in run_dir.iterdir():
            child.unlink()
    else:
        run_dir.mkdir(parents=True, exist_ok=True)

    started_at = _now_iso()
    summary_patients = []
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futures = {
            ex.submit(_run_one, agent, compiled_task, corpus_root, pid, run_dir): pid
            for pid in patient_ids
        }
        for future in as_completed(futures):
            summary_patients.append(future.result())

    # Stable order in the summary regardless of completion order
    pid_order = {pid: i for i, pid in enumerate(patient_ids)}
    summary_patients.sort(key=lambda p: pid_order[p["patient_id"]])

    completed_at = _now_iso()
    summary = {
        "run_id": run_id,
        "started_at": started_at,
        "completed_at": completed_at,
        "agent_entrypoint": agent_entrypoint,
        "compiled_task_sha": compiled_task.get("source_document_sha"),
        "concurrency": concurrency,
        "patients": summary_patients,
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_batch.py -v
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/lib/chart_review/batch.py chart-review-platform/lib/tests/test_batch.py
git commit -m "Add chart_review.batch.run_batch orchestration

ThreadPoolExecutor dispatches one worker per patient, invokes the
configured agent entrypoint (module:function), writes per-patient
ReviewRecord JSON + summary.json. Captures agent exceptions as
status='error' rows in the summary; aborts before any work if
patients are missing, run dir already exists, or the agent
entrypoint can't be imported."
```

---

## Task 3: `--validate` flag — schema-validate each output before writing

**Files:**
- Modify: `chart-review-platform/lib/chart_review/batch.py`
- Modify: `chart-review-platform/lib/tests/test_batch.py`

- [ ] **Step 1: Append the failing test**

Append to `chart-review-platform/lib/tests/test_batch.py`:

```python


# ---- Test 6: --validate flag ----

def test_batch_validates_when_flag_set(tmp_path):
    corpus = _build_fake_corpus(tmp_path / "corpus", ["patient_a"])

    def malformed_agent(compiled_task, corpus_root, patient_id):
        # Missing required fields like record_id, task_document_sha, etc.
        return {"patient_id": patient_id}

    entry = _register_fake_agent("malformed", malformed_agent)

    # With --validate, the malformed record is treated as an error
    summary_v = run_batch(
        compiled_task=_compiled_task(),
        corpus_root=corpus,
        patient_ids=["patient_a"],
        agent_entrypoint=entry,
        concurrency=1,
        run_id="test_run_06_validated",
        output_dir=tmp_path / "runs",
        validate=True,
    )
    assert summary_v["patients"][0]["status"] == "error"
    assert "schema" in summary_v["patients"][0]["error"].lower()
    assert not (tmp_path / "runs" / "test_run_06_validated" / "patient_a.json").exists()

    # Without --validate, the malformed record lands on disk as-is
    summary_no_v = run_batch(
        compiled_task=_compiled_task(),
        corpus_root=corpus,
        patient_ids=["patient_a"],
        agent_entrypoint=entry,
        concurrency=1,
        run_id="test_run_06_unvalidated",
        output_dir=tmp_path / "runs",
        validate=False,
    )
    assert summary_no_v["patients"][0]["status"] == "ok"
    assert (tmp_path / "runs" / "test_run_06_unvalidated" / "patient_a.json").exists()
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_batch.py::test_batch_validates_when_flag_set -v
```

Expected: FAIL with `TypeError: run_batch() got an unexpected keyword argument 'validate'`.

- [ ] **Step 3: Add the `validate` parameter to `run_batch`**

Modify `chart-review-platform/lib/chart_review/batch.py`. Update the imports at the top:

```python
from .validator import validate_review_record
```

Update the signature of `run_batch` to add `validate: bool = False` (after `force_overwrite`). Then update `_run_one` to accept a `validate` parameter and a contracts directory:

Replace `_run_one` with:

```python
def _run_one(
    agent: Callable,
    compiled_task: dict,
    corpus_root: Path,
    patient_id: str,
    run_dir: Path,
    *,
    validate: bool,
    contracts_dir: Path | None,
) -> dict:
    """Run the agent on one patient. Returns a summary entry dict."""
    started_ms = time.time() * 1000
    try:
        record = agent(compiled_task, corpus_root, patient_id)
        if not isinstance(record, dict):
            raise TypeError(
                f"agent returned {type(record).__name__}, expected dict"
            )
        if validate:
            assert contracts_dir is not None
            result = validate_review_record(record, contracts_dir)
            if result["status"] != "pass":
                raise ValueError(
                    f"schema validation failed: {'; '.join(result['errors'])}"
                )
        out_path = run_dir / f"{patient_id}.json"
        out_path.write_text(json.dumps(record, indent=2) + "\n")
        return {
            "patient_id": patient_id,
            "status": "ok",
            "duration_ms": int(time.time() * 1000 - started_ms),
            "output_path": str(out_path),
        }
    except Exception as e:
        return {
            "patient_id": patient_id,
            "status": "error",
            "duration_ms": int(time.time() * 1000 - started_ms),
            "error": f"{type(e).__name__}: {e}",
        }
```

Update `run_batch`'s body to pass the new arguments. Add a parameter `contracts_dir: Path | None = None` to `run_batch`'s signature; if `validate=True` and `contracts_dir` is None, default it by walking up from `corpus_root` to the platform root and joining `contracts/`. Replace the futures dict with:

```python
    if validate and contracts_dir is None:
        # Default: assume corpus_root is at <platform>/corpus and contracts at <platform>/contracts
        contracts_dir = corpus_root.parent / "contracts"

    started_at = _now_iso()
    summary_patients = []
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futures = {
            ex.submit(
                _run_one,
                agent, compiled_task, corpus_root, pid, run_dir,
                validate=validate, contracts_dir=contracts_dir,
            ): pid
            for pid in patient_ids
        }
        for future in as_completed(futures):
            summary_patients.append(future.result())
```

Also simplify the `output_path` assembly while you're at it — drop the relative-to-parent guard and just store `str(out_path)`. (The earlier guard was overly clever; absolute paths are fine.)

- [ ] **Step 4: Run all batch tests**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_batch.py -v
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/lib/chart_review/batch.py chart-review-platform/lib/tests/test_batch.py
git commit -m "Add --validate flag to run_batch

When validate=True, each agent's ReviewRecord is checked against
contracts/review_record.schema.json before being written. Records
that fail validation are marked status='error' with a 'schema
validation failed' message; other workers continue."
```

---

## Task 4: `chart-review batch` CLI subcommand

**Files:**
- Modify: `chart-review-platform/lib/chart_review/cli.py`
- Modify: `chart-review-platform/lib/tests/test_batch.py`

- [ ] **Step 1: Append the failing CLI test**

Append to `chart-review-platform/lib/tests/test_batch.py`:

```python


# ---- Test 7: CLI integration ----

def test_cli_batch_command(tmp_path, capsys):
    corpus = _build_fake_corpus(tmp_path / "corpus", ["patient_a", "patient_b"])

    # Write a compiled_task.json next to the test corpus
    (tmp_path / "compiled_task.json").write_text(json.dumps(_compiled_task()))

    from chart_review.cli import main
    rc = main([
        "batch", str(tmp_path / "compiled_task.json"),
        "--patients", "patient_a,patient_b",
        "--corpus-root", str(corpus),
        "--agent", "chart_review.agents.stub:run",
        "--concurrency", "2",
        "--run-id", "cli_test_run",
        "--output-dir", str(tmp_path / "runs"),
    ])
    assert rc == 0
    assert (tmp_path / "runs" / "cli_test_run" / "summary.json").is_file()
    out = capsys.readouterr().out
    assert "patient_a" in out
    assert "patient_b" in out
    assert "ok" in out


def test_cli_batch_returns_nonzero_on_error(tmp_path, capsys):
    """If any patient errors, the CLI exit code must be 1."""
    corpus = _build_fake_corpus(tmp_path / "corpus", ["patient_a"])
    (tmp_path / "compiled_task.json").write_text(json.dumps(_compiled_task()))

    def boom_agent(compiled_task, corpus_root, patient_id):
        raise RuntimeError("boom")
    entry = _register_fake_agent("cli_boom", boom_agent)

    from chart_review.cli import main
    rc = main([
        "batch", str(tmp_path / "compiled_task.json"),
        "--patients", "patient_a",
        "--corpus-root", str(corpus),
        "--agent", entry,
        "--run-id", "cli_test_error",
        "--output-dir", str(tmp_path / "runs"),
    ])
    assert rc == 1
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_batch.py::test_cli_batch_command tests/test_batch.py::test_cli_batch_returns_nonzero_on_error -v
```

Expected: FAIL with `argparse` complaining about an unknown subcommand `batch`.

- [ ] **Step 3: Add the `batch` subcommand to `cli.py`**

Modify `chart-review-platform/lib/chart_review/cli.py`. Near the top imports, add:

```python
from datetime import datetime, timezone
from .batch import run_batch
```

Then add this `cmd_batch` function near the other `cmd_*` definitions (place it after `cmd_list_patients`):

```python
def cmd_batch(args) -> int:
    compiled = json.loads(Path(args.compiled_task).read_text())

    # Resolve patient list
    selected = sum(bool(x) for x in (args.patients, args.patients_file, args.all))
    if selected != 1:
        print(
            "Exactly one of --patients, --patients-file, or --all is required.",
            file=sys.stderr,
        )
        return 1
    if args.patients:
        patient_ids = [p.strip() for p in args.patients.split(",") if p.strip()]
    elif args.patients_file:
        patient_ids = [
            line.strip()
            for line in Path(args.patients_file).read_text().splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
    else:
        from .corpus import iter_patients
        patient_ids = [p["patient_id"] for p in iter_patients(Path(args.corpus_root))]

    if not patient_ids:
        print("No patients selected.", file=sys.stderr)
        return 1

    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")

    try:
        summary = run_batch(
            compiled_task=compiled,
            corpus_root=Path(args.corpus_root),
            patient_ids=patient_ids,
            agent_entrypoint=args.agent,
            concurrency=args.concurrency,
            run_id=run_id,
            output_dir=Path(args.output_dir),
            force_overwrite=args.force_overwrite,
            validate=args.validate,
        )
    except (ImportError, FileNotFoundError, FileExistsError) as e:
        print(f"batch aborted: {e}", file=sys.stderr)
        return 1

    # Print a summary table
    n_ok = sum(1 for p in summary["patients"] if p["status"] == "ok")
    n_err = sum(1 for p in summary["patients"] if p["status"] == "error")
    print(f"Run {run_id}  ({n_ok} ok, {n_err} error)")
    print(f"  output: {Path(args.output_dir) / run_id}")
    print()
    print(f"  {'patient_id':<40} {'status':<8} {'ms':>8}")
    print(f"  {'-'*40} {'-'*8} {'-'*8}")
    for p in summary["patients"]:
        print(f"  {p['patient_id']:<40} {p['status']:<8} {p['duration_ms']:>8}")
        if p["status"] == "error":
            print(f"      {p['error']}")
    return 0 if n_err == 0 else 1
```

Then register the subcommand inside `main()` next to the other `sub.add_parser` blocks (place it after the `list-patients` parser):

```python
    p_b = sub.add_parser("batch", help="Run an agent across many patients in parallel")
    p_b.add_argument("compiled_task", help="Path to compiled_task.json")
    p_b.add_argument("--patients", help="Comma-separated patient_ids")
    p_b.add_argument("--patients-file", help="Path to file listing patient_ids (one per line)")
    p_b.add_argument("--all", action="store_true", help="Run against every patient in the corpus")
    p_b.add_argument("--corpus-root", default="corpus", help="Corpus directory")
    p_b.add_argument("--agent", default="chart_review.agents.stub:run", help="Agent entrypoint module:function")
    p_b.add_argument("--concurrency", type=int, default=5, help="Worker threads")
    p_b.add_argument("--run-id", help="Run identifier (default: ISO timestamp)")
    p_b.add_argument("--output-dir", default="runs", help="Base directory for run outputs")
    p_b.add_argument("--force-overwrite", action="store_true", help="Replace an existing run directory")
    p_b.add_argument("--validate", action="store_true", help="Schema-validate each ReviewRecord before writing")
    p_b.set_defaults(func=cmd_batch)
```

- [ ] **Step 4: Run all batch tests**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_batch.py -v
```

Expected: PASS, 8 tests (6 original + 2 CLI).

- [ ] **Step 5: Smoke-test against the real corpus**

```sh
cd "Studies/Chart Review Agents/chart-review-platform"
.venv/bin/chart-review batch ui/public/fixtures/compiled_task.json --all --concurrency 5 --run-id smoke_01
```

Expected output: a summary table with all 20 patients listed as `status=ok`. The `runs/smoke_01/` directory should now contain 20 per-patient JSON files plus `summary.json`.

```sh
ls runs/smoke_01/ | wc -l   # should print 21 (20 patients + summary.json)
```

- [ ] **Step 6: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/lib/chart_review/cli.py chart-review-platform/lib/tests/test_batch.py
git commit -m "Add 'chart-review batch' CLI subcommand

Wires the existing run_batch orchestrator to argparse with all the
documented flags. Patient selection is mutually exclusive: exactly
one of --patients, --patients-file, or --all is required. Default
agent is chart_review.agents.stub:run; default concurrency 5;
default run-id is the current ISO timestamp; default output-dir
is runs/. The CLI exits 0 when every patient succeeds, 1 if any
errored or if the run was aborted before starting."
```

---

## Task 5: `.gitignore` runs/ + integration test against real corpus

**Files:**
- Create or modify: `chart-review-platform/.gitignore`
- Modify: `chart-review-platform/lib/tests/test_batch.py`

- [ ] **Step 1: Add `runs/` to `.gitignore`**

Check whether `chart-review-platform/.gitignore` exists. If it does, append `runs/` to it. If it does not, create it:

```sh
cd "Studies/Chart Review Agents/chart-review-platform"
if [ -f .gitignore ]; then
  echo "runs/" >> .gitignore
else
  cat > .gitignore <<'EOF'
.venv/
build/
__pycache__/
*.pyc

# Async batch runner outputs — ephemeral test artifacts, not source-of-truth.
runs/
EOF
fi
```

If the file already existed, also verify its current contents are still sensible. Read it; if there are no entries for the venv / build / pyc, add them too. Do not remove existing entries.

- [ ] **Step 2: Append the integration test**

Append to `chart-review-platform/lib/tests/test_batch.py`:

```python


# ---- Test 8: integration against real corpus ----

def test_batch_against_real_hand_crafted_patients(tmp_path):
    """Run the stub agent against the 5 hand-crafted patients in the
    actual corpus. This locks in the real-world integration path."""
    output_dir = tmp_path / "runs"
    hand_crafted = [
        "patient_neg_hard_01",
        "patient_probable_fhx_01",
        "patient_confirmed_reread_01",
        "patient_probable_cytology_01",
        "patient_icd_z85_coexist_01",
    ]

    summary = run_batch(
        compiled_task=_compiled_task(),
        corpus_root=ROOT / "corpus",
        patient_ids=hand_crafted,
        agent_entrypoint="chart_review.agents.stub:run",
        concurrency=5,
        run_id="hand_crafted_smoke",
        output_dir=output_dir,
    )

    assert len(summary["patients"]) == 5
    for p in summary["patients"]:
        assert p["status"] == "ok", p
    for pid in hand_crafted:
        assert (output_dir / "hand_crafted_smoke" / f"{pid}.json").is_file()
```

- [ ] **Step 3: Run all batch tests + the full suite**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_batch.py -v
python3 -m pytest -q 2>&1 | tail -5
```

Expected: 9 batch tests pass; full suite shows everything passing (was 61; now 61 + 9 batch + 5 stub = 75; but Task 1 already added 5 stub tests, so the increment is +9 batch tests = 70 total).

- [ ] **Step 4: Verify `runs/` is ignored**

```sh
cd "Studies/Chart Review Agents"
# Run the smoke against the real corpus to populate runs/
chart-review-platform/.venv/bin/chart-review batch \
  chart-review-platform/ui/public/fixtures/compiled_task.json \
  --all \
  --corpus-root chart-review-platform/corpus \
  --output-dir chart-review-platform/runs \
  --run-id ignore_smoke
git status -s | grep runs/ || echo "runs/ is correctly ignored"
```

Expected: prints `runs/ is correctly ignored`. If git status DOES show `chart-review-platform/runs/`, the .gitignore didn't take effect — re-check the path.

- [ ] **Step 5: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/.gitignore chart-review-platform/lib/tests/test_batch.py
git commit -m "Ignore runs/ + add real-corpus integration test for batch runner

runs/ holds ephemeral output of chart-review batch and is not
source-of-truth — added to .gitignore. test_batch_against_real_hand_crafted_patients
runs the stub agent against the 5 committed hand-crafted patients
and asserts all 5 ReviewRecords land on disk. This is the
end-to-end smoke test for the runner integrating with the real
corpus."
```

---

## Self-review

**1. Spec coverage**

- Goal — adds a `chart-review batch` subcommand that runs an agent in parallel via threads — covered by Task 2 (orchestrator) + Task 4 (CLI).
- Phase 1 exit criterion (<5 min for 20 patients, parallel) — Task 4 Step 5 smoke runs all 20 patients with the stub agent (<10s); the threading primitive is in place for the real agent.
- Architecture (ThreadPoolExecutor, agent entrypoint, run-id-scoped output) — Task 2.
- Agent interface (`run(compiled_task, corpus_root, patient_id) -> dict`) — Task 1 + Task 2.
- CLI flags (--patients/--patients-file/--all, --corpus-root, --agent, --concurrency, --run-id, --output-dir, --force-overwrite, --validate) — Task 4 Step 3.
- Mutually-exclusive patient selection — Task 4 Step 3 (`selected != 1` guard).
- Output shapes (per-patient JSON + summary.json with prescribed fields) — Task 2 (`run_batch` writes both); summary fields verified by Task 2 Step 1's first test.
- Error handling table (5 scenarios) — covered: ImportError (Task 2 Test 5), FileNotFoundError (Task 2 Test 3), FileExistsError (Task 2 Test 4), agent exception (Task 2 Test 2), --validate path (Task 3 Test 6). Non-dict return is folded into agent-exception handling via TypeError in `_run_one`.
- Stub agent (no_info per leaf, low confidence, empty evidence) — Task 1.
- Tests (the spec's 6 test cases) — Tasks 1+2+3+4+5 contain 5 stub tests + 8 batch tests = 13 tests; this exceeds the spec's 6 because we split stub testing into its own file (5 tests) and added 2 CLI integration tests + 1 real-corpus integration test.
- Out-of-scope items confirmed not implemented: scoring, faithfulness, derivation, retry, progress UI, cost tracking, stub_ground_truth.
- Open questions — not needed for the plan; they're notes for follow-up.

**2. Placeholder scan**

No TBD/TODO/incomplete steps. Every code block is complete and runnable. Every shell command has the working directory + expected output.

**3. Type consistency**

- `run_batch` signature uses `corpus_root: Path` everywhere; tests construct with `tmp_path / "corpus"` (Path); CLI passes `Path(args.corpus_root)`.
- `agent_entrypoint: str` is consistent across spec, function, and CLI.
- `concurrency: int` is consistent; CLI uses `type=int`.
- `validate: bool = False` added in Task 3, then used in Task 4's CLI.
- Function names: `_resolve_agent`, `_check_patients_exist`, `_now_iso`, `_run_one`, `run_batch` — all consistent across tasks.
- Stub's `run(compiled_task, corpus_root, patient_id)` signature matches what `run_batch` invokes via `agent(compiled_task, corpus_root, patient_id)`.
- Test fixture names (`_compiled_task`, `_build_fake_corpus`, `_register_fake_agent`) — consistent across all batch test files.

No issues found.
