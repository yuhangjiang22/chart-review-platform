# Synthetic Patient Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 20-patient synthetic chart-review corpus organized as a filesystem the agent navigates with bash, with five hand-crafted designed-to-fail cases and fifteen API-generated cases, plus the library / CLI / UI plumbing that consumes it.

**Architecture:** Each patient is a directory under `chart-review-platform/corpus/patients/` containing `meta.json`, `ground_truth.json`, a `notes/` directory of date-prefixed `.txt` files, and an `omop/` directory of per-table `.json` files. A thin `chart_review.corpus` Python module wraps `pathlib` + `subprocess.run(["grep",...])` against the directory. A generation script (`tools/generate_corpus.py`) produces the API-generated patients from a `patient_seeds.yaml` source-of-truth file. The chart-review CLI gains a `list-patients` command; the UI's case list reads `/corpus/index.json` to populate the multi-chart picker; `demo.sh` mounts the corpus.

**Tech Stack:** Python 3.12 (`pathlib`, `subprocess`, `pyyaml`, `jsonschema`, `anthropic` SDK for the generation script), pytest, React 18 / Babel (UI is unchanged tooling).

---

## Task 1: Corpus skeleton + JSON Schemas

**Files:**
- Create: `chart-review-platform/corpus/README.md`
- Create: `chart-review-platform/corpus/index.json`
- Create: `chart-review-platform/corpus/schemas/meta.schema.json`
- Create: `chart-review-platform/corpus/schemas/ground_truth.schema.json`
- Create: `chart-review-platform/corpus/schemas/index.schema.json`
- Create: `chart-review-platform/corpus/concepts/icd10cm.json`

- [ ] **Step 1: Write the failing test for schema validation**

Create `chart-review-platform/lib/tests/test_corpus_schemas.py`:

```python
"""Verify the corpus JSON Schemas exist and accept canonical examples."""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def test_meta_schema_accepts_canonical_example():
    schema = _load(CORPUS / "schemas" / "meta.schema.json")
    sample = {
        "patient_id": "patient_001",
        "category": "confirmed_nsclc",
        "demographics": {"age": 68, "sex": "F"},
        "smoking": "30 pack-years, quit 2018",
        "index_date": "2024-12-09",
        "doc_types": ["ct_chest", "surgical_pathology", "oncology_progress"],
        "generated_by": "hand",
    }
    Draft202012Validator(schema).validate(sample)


def test_ground_truth_schema_accepts_canonical_example():
    schema = _load(CORPUS / "schemas" / "ground_truth.schema.json")
    sample = {
        "patient_id": "patient_001",
        "category": "confirmed_nsclc",
        "lung_cancer_status": "confirmed",
        "leaf_answers": {
            "pathology_report_present": "yes",
            "pathology_lung_primary": "nsclc",
            "cytology_supports_lung_primary": "not_applicable",
            "imaging_lung_lesion": "yes",
            "oncologist_lung_cancer_diagnosis_in_note": "yes",
            "icd_lung_cancer_present": "yes",
        },
        "applicability": {"cytology_supports_lung_primary": "not_applicable"},
        "expected_contradicting_evidence_fields": [],
        "difficulty": "easy",
        "difficulty_notes": "Clean confirmed-NSCLC.",
    }
    Draft202012Validator(schema).validate(sample)


def test_index_schema_accepts_canonical_example():
    schema = _load(CORPUS / "schemas" / "index.schema.json")
    sample = {
        "generated_at": "2026-04-29T00:00:00Z",
        "model_id": "claude-sonnet-4-6",
        "git_sha_at_generation": "a55011f",
        "patients": [
            {
                "patient_id": "patient_001",
                "category": "confirmed_nsclc",
                "difficulty": "easy",
                "headline": "68F, hemoptysis, NSCLC adenocarcinoma confirmed by surgical pathology.",
            }
        ],
    }
    Draft202012Validator(schema).validate(sample)
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
source ../.venv/bin/activate
python3 -m pytest tests/test_corpus_schemas.py -v
```

Expected: FAIL with `FileNotFoundError` on `corpus/schemas/meta.schema.json`.

- [ ] **Step 3: Create the corpus directory tree**

```sh
cd "Studies/Chart Review Agents/chart-review-platform"
mkdir -p corpus/schemas corpus/concepts corpus/patients
```

- [ ] **Step 4: Write `corpus/schemas/meta.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/corpus/schemas/meta.schema.json",
  "title": "PatientMeta",
  "type": "object",
  "required": ["patient_id", "category", "demographics", "index_date", "doc_types", "generated_by"],
  "properties": {
    "patient_id": { "type": "string", "pattern": "^patient_[a-z0-9_]+$" },
    "category": { "type": "string", "enum": ["confirmed_nsclc", "sclc", "probable", "icd_only", "negative"] },
    "demographics": {
      "type": "object",
      "required": ["age", "sex"],
      "properties": {
        "age": { "type": "integer", "minimum": 0, "maximum": 120 },
        "sex": { "type": "string", "enum": ["M", "F"] },
        "region": { "type": "string" }
      }
    },
    "smoking": { "type": "string" },
    "index_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "doc_types": { "type": "array", "items": { "type": "string" } },
    "generated_by": { "type": "string", "enum": ["hand", "claude_api"] },
    "generation_run_id": { "type": "string" }
  }
}
```

- [ ] **Step 5: Write `corpus/schemas/ground_truth.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/corpus/schemas/ground_truth.schema.json",
  "title": "PatientGroundTruth",
  "type": "object",
  "required": ["patient_id", "category", "lung_cancer_status", "leaf_answers", "applicability", "expected_contradicting_evidence_fields", "difficulty"],
  "properties": {
    "patient_id": { "type": "string" },
    "category": { "type": "string" },
    "lung_cancer_status": { "type": "string", "enum": ["confirmed", "probable", "absent"] },
    "leaf_answers": {
      "type": "object",
      "required": ["pathology_report_present", "pathology_lung_primary", "cytology_supports_lung_primary", "imaging_lung_lesion", "oncologist_lung_cancer_diagnosis_in_note", "icd_lung_cancer_present"],
      "additionalProperties": true
    },
    "applicability": {
      "type": "object",
      "additionalProperties": { "type": "string", "enum": ["applicable", "not_applicable", "unknown"] }
    },
    "expected_contradicting_evidence_fields": { "type": "array", "items": { "type": "string" } },
    "difficulty": { "type": "string", "enum": ["easy", "hard"] },
    "difficulty_notes": { "type": "string" }
  }
}
```

- [ ] **Step 6: Write `corpus/schemas/index.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chart-review-platform/corpus/schemas/index.schema.json",
  "title": "CorpusIndex",
  "type": "object",
  "required": ["generated_at", "patients"],
  "properties": {
    "generated_at": { "type": "string" },
    "model_id": { "type": "string" },
    "prompt_version": { "type": "string" },
    "git_sha_at_generation": { "type": "string" },
    "patients": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["patient_id", "category", "difficulty"],
        "properties": {
          "patient_id": { "type": "string" },
          "category": { "type": "string" },
          "difficulty": { "type": "string", "enum": ["easy", "hard"] },
          "headline": { "type": "string" }
        }
      }
    }
  }
}
```

- [ ] **Step 7: Write a curated `corpus/concepts/icd10cm.json`**

```json
{
  "C34.10": "Malignant neoplasm of unspecified part of bronchus or lung",
  "C34.11": "Malignant neoplasm of upper lobe, right bronchus or lung",
  "C34.12": "Malignant neoplasm of upper lobe, left bronchus or lung",
  "C34.30": "Malignant neoplasm of lower lobe, unspecified bronchus or lung",
  "C34.31": "Malignant neoplasm of lower lobe, right bronchus or lung",
  "C34.32": "Malignant neoplasm of lower lobe, left bronchus or lung",
  "C34.90": "Malignant neoplasm of unspecified part of unspecified bronchus or lung",
  "Z85.118": "Personal history of other malignant neoplasm of bronchus and lung",
  "J18.9": "Pneumonia, unspecified organism",
  "R09.81": "Nasal congestion",
  "R91.8": "Other nonspecific abnormal finding of lung field",
  "I10": "Essential (primary) hypertension",
  "J44.9": "Chronic obstructive pulmonary disease, unspecified"
}
```

- [ ] **Step 8: Write a placeholder `corpus/index.json`** (will be regenerated later by the generation script):

```json
{
  "generated_at": "2026-04-29T00:00:00Z",
  "model_id": "pending",
  "patients": []
}
```

- [ ] **Step 9: Write `corpus/README.md`**

```markdown
# Synthetic Chart-Review Corpus

20 synthetic patients used by the chart-review platform for benchmarking and multi-chart workflows.

See `docs/superpowers/specs/2026-04-29-synthetic-patient-corpus-design.md` for the design rationale.

## Layout

- `index.json` — generated manifest of all patients with category + difficulty + headline.
- `schemas/` — JSON Schemas the per-patient files validate against.
- `concepts/icd10cm.json` — curated ICD-10-CM lookup (just the codes the lung cancer task touches).
- `patients/<patient_id>/`
  - `meta.json` — demographics, index date, doc-type tags, generation provenance.
  - `ground_truth.json` — canonical leaf-field answers, applicability, expected contradicting-evidence fields, difficulty.
  - `notes/<YYYY-MM-DD>__<doc_type>.txt` — flat-text clinical notes.
  - `omop/{conditions,procedures,measurements,drugs,observations,encounters}.json` — per-table OMOP rows for this patient.

## Agent navigation

Agents use bash. Examples:

```sh
ls corpus/patients/                                          # list all patients
ls corpus/patients/patient_001/notes/                        # patient timeline
grep -rln 'NSCLC' corpus/patients/patient_001/notes/         # find a term
cat corpus/patients/patient_001/notes/2024-11-26__surgical_pathology.txt
jq '.[] | select(.icd10cm | startswith("C34"))' corpus/patients/*/omop/conditions.json
```

## Regeneration

The 5 hand-crafted patients (`patient_*_hard_*` / `patient_confirmed_reread_01` / `patient_probable_cytology_01` / `patient_icd_z85_coexist_01`) have committed `.txt` files; the generation script copies their seeds + writes `meta.json` / `ground_truth.json` / OMOP. The 15 API-generated patients are produced by `tools/generate_corpus.py`.
```

- [ ] **Step 10: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_corpus_schemas.py -v
```

Expected: PASS, 3 tests.

- [ ] **Step 11: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/corpus chart-review-platform/lib/tests/test_corpus_schemas.py
git commit -m "Add corpus skeleton + JSON Schemas

Establishes corpus/ directory tree, per-file JSON Schemas, curated
ICD-10-CM lookup, and placeholder index. Schemas validated by
test_corpus_schemas.py."
```

---

## Task 2: `chart_review.corpus` library module

**Files:**
- Create: `chart-review-platform/lib/chart_review/corpus.py`
- Create: `chart-review-platform/lib/tests/test_corpus_library.py`

- [ ] **Step 1: Write the failing tests**

Create `chart-review-platform/lib/tests/test_corpus_library.py`:

```python
"""Tests for chart_review.corpus — thin filesystem-as-API helpers."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from chart_review.corpus import (
    iter_patients,
    load_meta,
    load_ground_truth,
    read_note,
    grep_notes,
    omop_query,
)


@pytest.fixture()
def fake_corpus(tmp_path: Path) -> Path:
    pat = tmp_path / "patients" / "patient_001"
    (pat / "notes").mkdir(parents=True)
    (pat / "omop").mkdir()
    (pat / "meta.json").write_text(json.dumps({
        "patient_id": "patient_001",
        "category": "confirmed_nsclc",
        "demographics": {"age": 68, "sex": "F"},
        "index_date": "2024-12-09",
        "doc_types": ["ct_chest"],
        "generated_by": "hand",
    }))
    (pat / "ground_truth.json").write_text(json.dumps({
        "patient_id": "patient_001",
        "category": "confirmed_nsclc",
        "lung_cancer_status": "confirmed",
        "leaf_answers": {},
        "applicability": {},
        "expected_contradicting_evidence_fields": [],
        "difficulty": "easy",
    }))
    (pat / "notes" / "2024-11-26__surgical_pathology.txt").write_text(
        "Final diagnosis: ADENOCARCINOMA of the lung.\nNSCLC subtype.\n"
    )
    (pat / "omop" / "conditions.json").write_text(json.dumps([
        {"row_id": 1, "icd10cm": "C34.10", "concept_name": "Malignant neoplasm bronchus", "status": "active"}
    ]))
    return tmp_path


def test_iter_patients_returns_each_patient_dir(fake_corpus: Path):
    patients = list(iter_patients(fake_corpus))
    assert len(patients) == 1
    assert patients[0]["patient_id"] == "patient_001"


def test_load_meta(fake_corpus: Path):
    meta = load_meta(fake_corpus, "patient_001")
    assert meta["category"] == "confirmed_nsclc"


def test_load_ground_truth(fake_corpus: Path):
    gt = load_ground_truth(fake_corpus, "patient_001")
    assert gt["lung_cancer_status"] == "confirmed"


def test_read_note(fake_corpus: Path):
    text = read_note(fake_corpus, "patient_001", "2024-11-26__surgical_pathology.txt")
    assert "ADENOCARCINOMA" in text


def test_grep_notes_matches(fake_corpus: Path):
    hits = grep_notes(fake_corpus, "patient_001", "NSCLC")
    assert len(hits) == 1
    assert hits[0]["note_filename"] == "2024-11-26__surgical_pathology.txt"
    assert "NSCLC" in hits[0]["line"]


def test_grep_notes_no_match(fake_corpus: Path):
    hits = grep_notes(fake_corpus, "patient_001", "xyz_no_such_term")
    assert hits == []


def test_omop_query_filter(fake_corpus: Path):
    rows = omop_query(fake_corpus, "patient_001", "conditions", {"icd10cm_prefix": "C34"})
    assert len(rows) == 1
    assert rows[0]["icd10cm"] == "C34.10"


def test_omop_query_no_match(fake_corpus: Path):
    rows = omop_query(fake_corpus, "patient_001", "conditions", {"icd10cm_prefix": "Z99"})
    assert rows == []
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_corpus_library.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chart_review.corpus'`.

- [ ] **Step 3: Implement `chart_review/corpus.py`**

Create `chart-review-platform/lib/chart_review/corpus.py`:

```python
"""Filesystem-as-API helpers for the synthetic patient corpus.

Each patient is a directory under <corpus_root>/patients/<patient_id>/.
The agent's tool surface is bash (grep, cat, jq) — these helpers exist so
the platform's Python code (CLI, batch runner, validation tests, the
synthetic agent adapter) can talk to the same corpus without re-shelling.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Iterator


def _patients_dir(corpus_root: Path) -> Path:
    return Path(corpus_root) / "patients"


def iter_patients(corpus_root: Path) -> Iterator[dict[str, Any]]:
    """Yield {'patient_id', 'path'} for each patient directory, sorted."""
    for d in sorted(_patients_dir(corpus_root).iterdir()):
        if d.is_dir() and d.name.startswith("patient_"):
            yield {"patient_id": d.name, "path": d}


def load_meta(corpus_root: Path, patient_id: str) -> dict[str, Any]:
    return json.loads((_patients_dir(corpus_root) / patient_id / "meta.json").read_text())


def load_ground_truth(corpus_root: Path, patient_id: str) -> dict[str, Any]:
    return json.loads((_patients_dir(corpus_root) / patient_id / "ground_truth.json").read_text())


def read_note(corpus_root: Path, patient_id: str, note_filename: str) -> str:
    return (_patients_dir(corpus_root) / patient_id / "notes" / note_filename).read_text()


def grep_notes(corpus_root: Path, patient_id: str, pattern: str) -> list[dict[str, Any]]:
    """Run `grep -n <pattern>` against the patient's notes/. Returns one entry
    per match: {'note_filename', 'line_number', 'line'}."""
    notes_dir = _patients_dir(corpus_root) / patient_id / "notes"
    if not notes_dir.exists():
        return []
    proc = subprocess.run(
        ["grep", "-n", "-E", pattern, "-r", str(notes_dir)],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode not in (0, 1):
        raise RuntimeError(f"grep failed (code {proc.returncode}): {proc.stderr}")
    out = []
    for raw in proc.stdout.splitlines():
        # Format: <path>:<line_number>:<line_content>
        m = re.match(r"^(?P<path>[^:]+):(?P<n>\d+):(?P<line>.*)$", raw)
        if not m:
            continue
        out.append({
            "note_filename": Path(m.group("path")).name,
            "line_number": int(m.group("n")),
            "line": m.group("line"),
        })
    return out


def omop_query(
    corpus_root: Path,
    patient_id: str,
    table: str,
    predicate: dict[str, Any],
) -> list[dict[str, Any]]:
    """Read the patient's OMOP `<table>.json` and filter by predicate.

    Predicate keys:
      - exact field name → exact match
      - <field>_prefix → string startswith
      - <field>_in → membership
    """
    path = _patients_dir(corpus_root) / patient_id / "omop" / f"{table}.json"
    if not path.exists():
        return []
    rows = json.loads(path.read_text())
    out = []
    for row in rows:
        if _row_matches(row, predicate):
            out.append(row)
    return out


def _row_matches(row: dict[str, Any], predicate: dict[str, Any]) -> bool:
    for key, want in predicate.items():
        if key.endswith("_prefix"):
            field = key[: -len("_prefix")]
            if not str(row.get(field, "")).startswith(want):
                return False
        elif key.endswith("_in"):
            field = key[: -len("_in")]
            if row.get(field) not in want:
                return False
        else:
            if row.get(key) != want:
                return False
    return True
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_corpus_library.py -v
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/lib/chart_review/corpus.py chart-review-platform/lib/tests/test_corpus_library.py
git commit -m "Add chart_review.corpus filesystem-as-API helpers

Thin wrappers over pathlib + grep + json: iter_patients, load_meta,
load_ground_truth, read_note, grep_notes, omop_query. The platform's
Python code (CLI, batch runner, validation tests, synthetic agent
adapter) consume the corpus through these helpers; the agent itself
uses bash."
```

---

## Task 3: First hand-crafted patient (`patient_neg_hard_01`)

This patient establishes the template the next four hand-crafted patients follow. Notes contain hedged-language phrases that test negation handling; final phenotype is `absent`.

**Files:**
- Create: `chart-review-platform/corpus/patients/patient_neg_hard_01/meta.json`
- Create: `chart-review-platform/corpus/patients/patient_neg_hard_01/ground_truth.json`
- Create: `chart-review-platform/corpus/patients/patient_neg_hard_01/notes/2024-08-22__pulmonology_consult.txt`
- Create: `chart-review-platform/corpus/patients/patient_neg_hard_01/notes/2024-08-29__ct_chest.txt`
- Create: `chart-review-platform/corpus/patients/patient_neg_hard_01/notes/2024-09-12__ed_visit.txt`
- Create: `chart-review-platform/corpus/patients/patient_neg_hard_01/notes/2024-10-04__pcp_followup.txt`
- Create: 6 OMOP `.json` files under `corpus/patients/patient_neg_hard_01/omop/`
- Create: `chart-review-platform/lib/tests/test_patient_neg_hard_01.py`

- [ ] **Step 1: Write the assertion test for this patient**

Create `chart-review-platform/lib/tests/test_patient_neg_hard_01.py`:

```python
"""Hand-crafted patient: tests negation + hedged-language handling.

The agent must NOT count hedged phrases like 'rule out', 'no evidence
of', 'low suspicion for' as positive signals. Final answer: absent.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from chart_review.corpus import grep_notes, load_ground_truth
from chart_review.derivation import evaluate_all

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"
PID = "patient_neg_hard_01"


def test_directory_exists():
    assert (CORPUS / "patients" / PID).is_dir()


def test_ground_truth_is_negative():
    gt = load_ground_truth(CORPUS, PID)
    assert gt["lung_cancer_status"] == "absent"
    assert gt["difficulty"] == "hard"


def test_notes_contain_hedged_phrases():
    """At least one of the canonical hedge phrases must appear."""
    hits = grep_notes(CORPUS, PID, r"rule out|no evidence of|low suspicion for")
    assert len(hits) > 0


def test_internal_consistency():
    """Running evaluate_all over leaf_answers must produce lung_cancer_status."""
    gt = load_ground_truth(CORPUS, PID)
    compiled = json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_neg_hard_01.py -v
```

Expected: FAIL — patient directory does not yet exist.

- [ ] **Step 3: Create `meta.json`**

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/meta.json`:

```json
{
  "patient_id": "patient_neg_hard_01",
  "category": "negative",
  "demographics": { "age": 71, "sex": "M", "region": "Pacific Northwest" },
  "smoking": "Former smoker, 25 pack-years, quit 1998",
  "index_date": "2024-10-04",
  "doc_types": ["pulmonology_consult", "ct_chest", "ed_visit", "pcp_followup"],
  "generated_by": "hand"
}
```

- [ ] **Step 4: Create `ground_truth.json`**

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/ground_truth.json`:

```json
{
  "patient_id": "patient_neg_hard_01",
  "category": "negative",
  "lung_cancer_status": "absent",
  "leaf_answers": {
    "pathology_report_present": "no",
    "pathology_lung_primary": "not_applicable",
    "cytology_supports_lung_primary": "no",
    "imaging_lung_lesion": "no",
    "oncologist_lung_cancer_diagnosis_in_note": "no",
    "icd_lung_cancer_present": "no"
  },
  "applicability": {
    "pathology_lung_primary": "not_applicable",
    "cytology_supports_lung_primary": "applicable"
  },
  "expected_contradicting_evidence_fields": [],
  "difficulty": "hard",
  "difficulty_notes": "Hand-crafted. Tests negation and hedged-language handling. Pulm consult, CT, and ED note all contain phrases like 'rule out', 'no evidence of', 'low suspicion for'. Agent must NOT count any of these as positive signals."
}
```

- [ ] **Step 5: Write the four notes**

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/notes/2024-08-22__pulmonology_consult.txt`:

```
PULMONOLOGY CONSULTATION
Provider: D. Yamada, MD — Pulmonary and Critical Care
Encounter date: 2024-08-22

HISTORY
71-year-old man with a 25 pack-year smoking history (quit 1998) presents
with a six-week chronic cough. No hemoptysis. No weight loss. No fever.
He is here from primary care to rule out lung cancer given his prior
tobacco exposure.

EXAMINATION
Lungs clear bilaterally. No wheezing. SpO2 97% on room air.

ASSESSMENT AND PLAN
Chronic cough, most likely post-viral or upper airway cough syndrome.
Low suspicion for malignancy clinically, but given smoking history I
will obtain a low-dose screening CT to be thorough. Will also empirically
trial intranasal steroid for upper airway cough syndrome.

D. Yamada, MD — electronically signed 2024-08-22 14:51
```

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/notes/2024-08-29__ct_chest.txt`:

```
LOW-DOSE SCREENING CT CHEST
Date of examination: 2024-08-29
Indication: chronic cough, smoking history, screening per pulmonology

TECHNIQUE
Low-dose helical CT chest without intravenous contrast.

FINDINGS
Lungs are clear with no consolidation, mass, or suspicious nodule
identified. No pleural effusion. No mediastinal or hilar
lymphadenopathy.

A 4 mm subpleural nodule is identified in the right lower lobe with
benign morphologic features (smooth margins, calcified center) most
consistent with a granuloma. Stable appearance compared with prior
imaging from 2021.

IMPRESSION
1. No evidence of pulmonary malignancy.
2. Stable benign-appearing right lower lobe granuloma; no follow-up
   imaging required per Lung-RADS criteria.

S. Mehta, MD — Radiology — electronically signed 2024-08-29
```

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/notes/2024-09-12__ed_visit.txt`:

```
EMERGENCY DEPARTMENT NOTE
Provider: J. Holloway, DO
Encounter date: 2024-09-12 03:14

CHIEF COMPLAINT
Cough with intermittent right-sided chest tightness.

HISTORY OF PRESENT ILLNESS
71-year-old man with prior smoking history presents overnight with
intermittent right-sided chest tightness over the past three days.
Recent screening CT (2024-08-29) was negative. Patient is anxious about
this and asked to be evaluated to rule out lung cancer despite the
recent imaging.

ASSESSMENT AND PLAN
Atypical chest discomfort, likely musculoskeletal. Recent CT showed no
evidence of pulmonary malignancy. ECG and troponin reassuring. Discharge
home with reassurance and PCP follow-up. Patient counseled that recent
imaging is not concerning for lung cancer.

J. Holloway, DO — electronically signed 2024-09-12 04:22
```

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/notes/2024-10-04__pcp_followup.txt`:

```
PRIMARY CARE FOLLOW-UP
Provider: T. Anand, MD — Family Medicine
Encounter date: 2024-10-04

HISTORY
71-year-old man returns for follow-up after pulmonology consultation
and ED visit. Cough has improved on intranasal steroid. No hemoptysis.

ASSESSMENT
1. Chronic cough — improving, post-viral / upper-airway cough syndrome.
   No evidence of pulmonary malignancy on recent screening CT; pulmonology
   confirmed low suspicion for malignancy. Continue current management.
2. Hypertension — controlled.
3. Tobacco use — former, sustained cessation since 1998.

Plan: continue intranasal steroid, recheck in 3 months. Routine annual
screening CT next due 2025-08.

T. Anand, MD — electronically signed 2024-10-04
```

- [ ] **Step 6: Create the OMOP files**

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/omop/conditions.json`:

```json
[
  { "row_id": 5001, "concept_id": 320128, "concept_name": "Essential hypertension", "icd10cm": "I10", "status": "active", "date": "2018-04-12" },
  { "row_id": 5002, "concept_id": 4119911, "concept_name": "Cough, chronic", "icd10cm": "R05.3", "status": "active", "date": "2024-08-22" }
]
```

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/omop/procedures.json`:

```json
[
  { "row_id": 6001, "concept_id": 4096774, "concept_name": "Computed tomography of thorax", "cpt": "71250", "procedure_date": "2024-08-29", "provider_specialty": "Radiology" }
]
```

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/omop/measurements.json`:

```json
[
  { "row_id": 7001, "concept_id": 3027018, "concept_name": "Heart rate", "value": 72, "unit": "/min", "date": "2024-08-22" },
  { "row_id": 7002, "concept_id": 3025315, "concept_name": "Body temperature", "value": 36.7, "unit": "C", "date": "2024-09-12" }
]
```

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/omop/drugs.json`:

```json
[
  { "row_id": 8001, "concept_id": 1308216, "concept_name": "Lisinopril 10 MG Oral Tablet", "rxnorm": "311353", "status": "active", "date_start": "2018-04-12" },
  { "row_id": 8002, "concept_id": 1115008, "concept_name": "Fluticasone 50 MCG/ACTUAT Nasal Spray", "rxnorm": "199286", "status": "active", "date_start": "2024-08-22" }
]
```

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/omop/observations.json`:

```json
[
  { "row_id": 9001, "concept_id": 4275495, "concept_name": "Smoking status", "value": "Former smoker, 25 pack-years, quit 1998", "date": "2024-08-22" }
]
```

Write `chart-review-platform/corpus/patients/patient_neg_hard_01/omop/encounters.json`:

```json
[
  { "row_id": 10001, "encounter_id": "enc_4581", "type": "Outpatient", "department": "Pulmonology", "primary_provider": "D. Yamada, MD", "start_date": "2024-08-22", "end_date": "2024-08-22" },
  { "row_id": 10002, "encounter_id": "enc_4612", "type": "ED", "department": "Emergency", "primary_provider": "J. Holloway, DO", "start_date": "2024-09-12", "end_date": "2024-09-12" },
  { "row_id": 10003, "encounter_id": "enc_4670", "type": "Outpatient", "department": "Primary Care", "primary_provider": "T. Anand, MD", "start_date": "2024-10-04", "end_date": "2024-10-04" }
]
```

- [ ] **Step 7: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_neg_hard_01.py -v
```

Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/corpus/patients/patient_neg_hard_01 chart-review-platform/lib/tests/test_patient_neg_hard_01.py
git commit -m "Add hand-crafted patient_neg_hard_01

Tests negation + hedged-language handling. Pulm consult, screening CT,
ED note, and PCP follow-up all contain phrases like 'rule out',
'no evidence of', 'low suspicion for'. Final phenotype: absent.
Agent must not be fooled by surface-level cues."
```

---

## Task 4a: `patient_probable_fhx_01`

Tests family-history attribution + Z85.118 decoy. Real signal: oncologist's active diagnosis + suspicious CT. Final: `probable`. `icd_lung_cancer_present` must be `no`, oncologist note must be `yes`.

**Files:**
- Create: `chart-review-platform/corpus/patients/patient_probable_fhx_01/meta.json`
- Create: `chart-review-platform/corpus/patients/patient_probable_fhx_01/ground_truth.json`
- Create: 4–5 notes under `corpus/patients/patient_probable_fhx_01/notes/`
- Create: 6 OMOP `.json` files
- Create: `chart-review-platform/lib/tests/test_patient_probable_fhx_01.py`

- [ ] **Step 1: Write the assertion test**

Create `chart-review-platform/lib/tests/test_patient_probable_fhx_01.py`:

```python
"""Hand-crafted patient: family-history decoy + Z85.118 co-existence.

The agent must distinguish 'father with lung cancer' (family history,
does NOT count) from the patient's own oncologist-documented active
diagnosis. The Z85.118 personal-history code must NOT trigger
icd_lung_cancer_present='yes'.
"""

from __future__ import annotations

import json
from pathlib import Path

from chart_review.corpus import grep_notes, load_ground_truth, omop_query
from chart_review.derivation import evaluate_all

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"
PID = "patient_probable_fhx_01"


def test_ground_truth_is_probable():
    gt = load_ground_truth(CORPUS, PID)
    assert gt["lung_cancer_status"] == "probable"
    assert gt["leaf_answers"]["icd_lung_cancer_present"] == "no"
    assert gt["leaf_answers"]["oncologist_lung_cancer_diagnosis_in_note"] == "yes"


def test_notes_contain_family_history_decoy():
    hits = grep_notes(CORPUS, PID, r"father.*lung cancer|family history.*lung")
    assert len(hits) > 0


def test_omop_has_z85_118_no_c34():
    z85_hits = omop_query(CORPUS, PID, "conditions", {"icd10cm": "Z85.118"})
    c34_hits = omop_query(CORPUS, PID, "conditions", {"icd10cm_prefix": "C34"})
    assert len(z85_hits) > 0
    assert len(c34_hits) == 0


def test_internal_consistency():
    gt = load_ground_truth(CORPUS, PID)
    compiled = json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_probable_fhx_01.py -v
```

Expected: FAIL — patient directory does not exist.

- [ ] **Step 3: Create `meta.json`**

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/meta.json`:

```json
{
  "patient_id": "patient_probable_fhx_01",
  "category": "probable",
  "demographics": { "age": 64, "sex": "F", "region": "Northeast" },
  "smoking": "Never smoker; significant secondhand-smoke exposure",
  "index_date": "2024-12-19",
  "doc_types": ["pcp_visit", "ct_chest", "oncology_consult", "oncology_progress"],
  "generated_by": "hand"
}
```

- [ ] **Step 4: Create `ground_truth.json`**

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/ground_truth.json`:

```json
{
  "patient_id": "patient_probable_fhx_01",
  "category": "probable",
  "lung_cancer_status": "probable",
  "leaf_answers": {
    "pathology_report_present": "no",
    "pathology_lung_primary": "not_applicable",
    "cytology_supports_lung_primary": "no",
    "imaging_lung_lesion": "yes",
    "oncologist_lung_cancer_diagnosis_in_note": "yes",
    "icd_lung_cancer_present": "no"
  },
  "applicability": {
    "pathology_lung_primary": "not_applicable",
    "cytology_supports_lung_primary": "applicable"
  },
  "expected_contradicting_evidence_fields": [],
  "difficulty": "hard",
  "difficulty_notes": "Hand-crafted. Multiple decoys for icd_lung_cancer_present and oncologist_lung_cancer_diagnosis_in_note. Family history of lung cancer (father), Z85.118 personal-history code. Real signal: treating oncologist documents active lung cancer diagnosis + suspicious CT. ICD must remain no (Z85.118 does not qualify; no C34 code present). Pathology not yet obtained."
}
```

- [ ] **Step 5: Write four notes**

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/notes/2024-11-08__pcp_visit.txt`:

```
PRIMARY CARE VISIT
Provider: L. Brennan, MD — Internal Medicine
Encounter date: 2024-11-08

HISTORY OF PRESENT ILLNESS
64-year-old never-smoker presents with a 7-week dry cough and unintentional
6-pound weight loss. Significant secondhand-smoke exposure (childhood
home, both parents smoked). Family history notable for a father with
lung cancer who died at age 67. Patient denies hemoptysis but reports
fatigue and reduced exercise tolerance.

PAST MEDICAL HISTORY
- Colorectal adenocarcinoma, stage I, surgically resected 2019. In
  ongoing surveillance, no recurrence.
- Hypertension.

ASSESSMENT AND PLAN
Subacute cough with weight loss in a never-smoker with significant
secondhand-smoke exposure and concerning family history. Will obtain
diagnostic CT chest with contrast and refer to thoracic oncology for
expedited evaluation given prior cancer history.

L. Brennan, MD — electronically signed 2024-11-08
```

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/notes/2024-11-22__ct_chest.txt`:

```
CT CHEST WITH CONTRAST
Date of examination: 2024-11-22
Indication: chronic cough, weight loss, family history of lung cancer

TECHNIQUE
Helical CT of the chest with intravenous contrast.

FINDINGS
A 2.6 cm spiculated mass is identified in the lingula of the left upper
lobe. Mediastinal lymphadenopathy is present, with the largest level 4L
node measuring 1.4 cm in short axis. No pleural effusion. No definite
distant metastases on this examination.

Surgical changes are noted in the right hemicolon consistent with prior
hemicolectomy.

IMPRESSION
1. 2.6 cm spiculated lingular mass with associated mediastinal
   lymphadenopathy, highly suspicious for primary lung malignancy.
2. Recommend tissue sampling and PET-CT for staging.
3. Stable post-surgical changes from prior hemicolectomy.

R. Patel, MD — Radiology — electronically signed 2024-11-22
```

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/notes/2024-12-04__oncology_consult.txt`:

```
THORACIC ONCOLOGY CONSULTATION
Provider: K. Chen, MD — Hematology/Oncology
Encounter date: 2024-12-04

REASON FOR CONSULTATION
New 2.6 cm spiculated lingular mass with mediastinal lymphadenopathy,
suspicious for primary lung malignancy. Requesting expedited evaluation
and treatment planning.

HISTORY
64-year-old never-smoker with significant secondhand-smoke exposure
presenting with cough and weight loss. CT chest 2024-11-22 demonstrates
a 2.6 cm spiculated lingular mass with level 4L lymphadenopathy. Family
history significant for a father with lung cancer.

PAST ONCOLOGIC HISTORY
Stage I colorectal adenocarcinoma resected 2019, no recurrence on
surveillance.

ASSESSMENT
This is a new primary lung cancer in a never-smoker with strong family
history and secondhand-smoke exposure. Imaging features and clinical
context are highly suspicious for primary non-small cell lung carcinoma.
We will proceed with CT-guided core biopsy and PET-CT. Pending tissue,
clinical impression is primary lung cancer.

PLAN
1. Refer for CT-guided core biopsy of lingular mass.
2. PET-CT for staging.
3. Return to clinic with results in 2 weeks.
4. Discuss molecular testing (EGFR, ALK, ROS1, PD-L1) once tissue available.

K. Chen, MD — electronically signed 2024-12-04
```

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/notes/2024-12-19__oncology_progress.txt`:

```
THORACIC ONCOLOGY PROGRESS NOTE
Provider: K. Chen, MD — Hematology/Oncology
Encounter date: 2024-12-19

INTERVAL HISTORY
Patient returns following imaging and biopsy referral. CT-guided core
biopsy was attempted on 2024-12-12 but was non-diagnostic; the radiology
team noted significant patient motion. PET-CT performed 2024-12-16 shows
intense FDG uptake in the lingular mass and the level 4L node. No
evidence of distant disease.

ASSESSMENT
Lung cancer, clinical stage IIIA, awaiting tissue confirmation. Initial
biopsy was non-diagnostic; will repeat with bronchoscopic approach.
Patient reports increasing fatigue and persistent cough. Discussed with
patient that we are treating this as lung cancer pending tissue.

PLAN
1. Re-biopsy via EBUS bronchoscopy scheduled 2024-12-30.
2. Continue supportive care.
3. Once tissue confirms histology, will initiate definitive therapy.
4. Patient is well-informed; understands working diagnosis is primary
   lung cancer.

K. Chen, MD — electronically signed 2024-12-19
```

- [ ] **Step 6: Create OMOP files**

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/omop/conditions.json`:

```json
[
  { "row_id": 5101, "concept_id": 320128, "concept_name": "Essential hypertension", "icd10cm": "I10", "status": "active", "date": "2015-06-01" },
  { "row_id": 5102, "concept_id": 4193869, "concept_name": "Personal history of malignant neoplasm of bronchus and lung", "icd10cm": "Z85.118", "status": "active", "date": "2017-03-15" },
  { "row_id": 5103, "concept_id": 4234254, "concept_name": "Personal history of malignant neoplasm of large intestine", "icd10cm": "Z85.038", "status": "active", "date": "2019-09-12" },
  { "row_id": 5104, "concept_id": 4119911, "concept_name": "Cough, chronic", "icd10cm": "R05.3", "status": "active", "date": "2024-11-08" },
  { "row_id": 5105, "concept_id": 4242415, "concept_name": "Unintentional weight loss", "icd10cm": "R63.4", "status": "active", "date": "2024-11-08" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/omop/procedures.json`:

```json
[
  { "row_id": 6101, "concept_id": 4096774, "concept_name": "Computed tomography of thorax", "cpt": "71260", "procedure_date": "2024-11-22", "provider_specialty": "Radiology" },
  { "row_id": 6102, "concept_id": 4321756, "concept_name": "CT-guided lung biopsy", "cpt": "32408", "procedure_date": "2024-12-12", "provider_specialty": "Interventional Radiology" },
  { "row_id": 6103, "concept_id": 4023758, "concept_name": "FDG PET-CT", "cpt": "78815", "procedure_date": "2024-12-16", "provider_specialty": "Nuclear Medicine" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/omop/measurements.json`:

```json
[
  { "row_id": 7101, "concept_id": 3013762, "concept_name": "Body weight", "value": 58.4, "unit": "kg", "date": "2024-11-08" },
  { "row_id": 7102, "concept_id": 3013762, "concept_name": "Body weight", "value": 56.7, "unit": "kg", "date": "2024-12-19" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/omop/drugs.json`:

```json
[
  { "row_id": 8101, "concept_id": 1308216, "concept_name": "Lisinopril 10 MG Oral Tablet", "rxnorm": "311353", "status": "active", "date_start": "2015-06-01" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/omop/observations.json`:

```json
[
  { "row_id": 9101, "concept_id": 4275495, "concept_name": "Smoking status", "value": "Never smoker", "date": "2024-11-08" },
  { "row_id": 9102, "concept_id": 4012614, "concept_name": "Family history of lung cancer", "value": "Father, deceased age 67", "date": "2024-11-08" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_fhx_01/omop/encounters.json`:

```json
[
  { "row_id": 10101, "encounter_id": "enc_5101", "type": "Outpatient", "department": "Primary Care", "primary_provider": "L. Brennan, MD", "start_date": "2024-11-08", "end_date": "2024-11-08" },
  { "row_id": 10102, "encounter_id": "enc_5102", "type": "Outpatient", "department": "Hematology/Oncology", "primary_provider": "K. Chen, MD", "start_date": "2024-12-04", "end_date": "2024-12-04" },
  { "row_id": 10103, "encounter_id": "enc_5103", "type": "Outpatient", "department": "Hematology/Oncology", "primary_provider": "K. Chen, MD", "start_date": "2024-12-19", "end_date": "2024-12-19" }
]
```

- [ ] **Step 7: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_probable_fhx_01.py -v
```

Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/corpus/patients/patient_probable_fhx_01 chart-review-platform/lib/tests/test_patient_probable_fhx_01.py
git commit -m "Add hand-crafted patient_probable_fhx_01

Tests family-history-of-lung-cancer decoy and Z85.118 personal-history
code co-existence (no C34 codes). Real signal: oncologist's active
working diagnosis backed by suspicious CT. icd_lung_cancer_present
must remain no; oncologist note must be yes; final = probable."
```

---

## Task 4b: `patient_confirmed_reread_01`

Tests the manual's "re-read pathology wins regardless of date" rule. Original report says SCLC; pathologist re-read addendum says NSCLC adenocarcinoma. Should populate `contradicting_evidence` on `pathology_lung_primary` citing the original report. Final: `confirmed`, primary=`nsclc`. **This is the patient that exercises the new `contradicting_evidence` contract field.**

**Files:**
- Create: `chart-review-platform/corpus/patients/patient_confirmed_reread_01/meta.json`
- Create: `chart-review-platform/corpus/patients/patient_confirmed_reread_01/ground_truth.json`
- Create: 4 notes including a single combined original + addendum pathology report
- Create: 6 OMOP `.json` files
- Create: `chart-review-platform/lib/tests/test_patient_confirmed_reread_01.py`

- [ ] **Step 1: Write the assertion test**

Create `chart-review-platform/lib/tests/test_patient_confirmed_reread_01.py`:

```python
"""Hand-crafted patient: pathology re-read overrides original.

Original surgical pathology report calls SCLC; pathologist re-read
addendum calls NSCLC adenocarcinoma. Manual rule: re-read wins
regardless of date. Agent must answer NSCLC AND populate
contradicting_evidence on pathology_lung_primary citing the SCLC
language from the original report.
"""

from __future__ import annotations

import json
from pathlib import Path

from chart_review.corpus import grep_notes, load_ground_truth
from chart_review.derivation import evaluate_all

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"
PID = "patient_confirmed_reread_01"


def test_ground_truth_is_confirmed_nsclc():
    gt = load_ground_truth(CORPUS, PID)
    assert gt["lung_cancer_status"] == "confirmed"
    assert gt["leaf_answers"]["pathology_lung_primary"] == "nsclc"
    assert "pathology_lung_primary" in gt["expected_contradicting_evidence_fields"]


def test_notes_contain_both_sclc_and_nsclc_calls():
    sclc_hits = grep_notes(CORPUS, PID, r"small[- ]cell")
    nsclc_hits = grep_notes(CORPUS, PID, r"non[- ]small[- ]cell|adenocarcinoma")
    assert len(sclc_hits) > 0, "Original SCLC reading must be present"
    assert len(nsclc_hits) > 0, "Re-read NSCLC reading must be present"


def test_pathology_note_has_addendum_language():
    hits = grep_notes(CORPUS, PID, r"ADDENDUM|RE-READ|reread")
    assert len(hits) > 0


def test_internal_consistency():
    gt = load_ground_truth(CORPUS, PID)
    compiled = json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_confirmed_reread_01.py -v
```

Expected: FAIL — patient directory does not exist.

- [ ] **Step 3: Create `meta.json`**

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/meta.json`:

```json
{
  "patient_id": "patient_confirmed_reread_01",
  "category": "confirmed_nsclc",
  "demographics": { "age": 73, "sex": "M", "region": "Southeast" },
  "smoking": "Current smoker, 50 pack-years",
  "index_date": "2025-03-18",
  "doc_types": ["ct_chest", "surgical_pathology_with_addendum", "oncology_progress", "molecular_pathology"],
  "generated_by": "hand"
}
```

- [ ] **Step 4: Create `ground_truth.json`**

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/ground_truth.json`:

```json
{
  "patient_id": "patient_confirmed_reread_01",
  "category": "confirmed_nsclc",
  "lung_cancer_status": "confirmed",
  "leaf_answers": {
    "pathology_report_present": "yes",
    "pathology_lung_primary": "nsclc",
    "cytology_supports_lung_primary": "not_applicable",
    "imaging_lung_lesion": "yes",
    "oncologist_lung_cancer_diagnosis_in_note": "yes",
    "icd_lung_cancer_present": "yes"
  },
  "applicability": {
    "cytology_supports_lung_primary": "not_applicable"
  },
  "expected_contradicting_evidence_fields": ["pathology_lung_primary"],
  "difficulty": "hard",
  "difficulty_notes": "Hand-crafted. Tests the manual's re-read rule. Original surgical pathology report calls SCLC based on initial morphology; pathologist re-read addendum (after immunohistochemistry) calls NSCLC adenocarcinoma. Manual rule states the re-read wins regardless of date. Agent should answer pathology_lung_primary=nsclc AND surface the original SCLC language as contradicting_evidence with reason_not_decisive citing the re-read rule."
}
```

- [ ] **Step 5: Write the four notes**

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/notes/2025-02-14__ct_chest.txt`:

```
CT CHEST WITH CONTRAST
Date of examination: 2025-02-14
Indication: chronic cough, hemoptysis, smoking history

FINDINGS
A 4.1 cm mass is identified in the right lower lobe with central
necrosis and ill-defined margins. Multiple subcentimeter mediastinal
nodes, the largest at level 7 measuring 1.1 cm in short axis. No
pleural effusion. Liver and adrenal glands appear unremarkable on the
included views.

IMPRESSION
1. 4.1 cm right lower lobe mass with central necrosis, highly suspicious
   for primary lung malignancy.
2. Borderline subcarinal lymphadenopathy.
3. Recommend tissue sampling.

A. Reyes, MD — Radiology — electronically signed 2025-02-14
```

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/notes/2025-02-28__surgical_pathology_with_addendum.txt`:

```
SURGICAL PATHOLOGY REPORT
Specimen: Right lower lobe lung mass, CT-guided core biopsy
Specimen received: 2025-02-25
Original report finalized: 2025-02-28
Pathologist (original): J. McGregor, MD

GROSS DESCRIPTION
Three core biopsy fragments, the longest measuring 1.6 cm. Submitted in
toto.

MICROSCOPIC DESCRIPTION
Sections demonstrate a malignant epithelial neoplasm with sheets of
small to intermediate-sized cells with scant cytoplasm and finely
stippled chromatin. Nuclear molding is noted. Mitoses are frequent
(>10 per high-power field). Necrosis is present. Initial morphologic
impression on H&E is small-cell carcinoma.

DIAGNOSIS (ORIGINAL)
Right lower lobe, core biopsy: SMALL-CELL CARCINOMA (SCLC).

J. McGregor, MD — electronically signed 2025-02-28


==================================================================
                            ADDENDUM
                        RE-READ AND REVISION
==================================================================

Addendum date: 2025-03-07
Re-reading pathologist: H. Okafor, MD — Thoracic Pathology

REASON FOR ADDENDUM
This case was sent for second-opinion thoracic pathology review and
immunohistochemical work-up given atypical morphologic features.

ADDITIONAL IMMUNOHISTOCHEMISTRY
- TTF-1: positive (diffuse, strong)
- Napsin A: positive
- p63 / p40: negative
- Synaptophysin: negative
- Chromogranin: negative
- CK7: positive
- Ki-67: ~35%

INTERPRETATION
The immunohistochemical profile is incompatible with small-cell
carcinoma (synaptophysin and chromogranin are negative; Ki-67 is too
low). The TTF-1+/Napsin A+/p40− profile is diagnostic of pulmonary
ADENOCARCINOMA. The original H&E features that suggested small-cell
morphology are reinterpreted as crush artifact and a basaloid growth
pattern.

REVISED DIAGNOSIS (RE-READ)
Right lower lobe, core biopsy: NON-SMALL-CELL LUNG CARCINOMA (NSCLC),
ADENOCARCINOMA SUBTYPE.

This addendum supersedes the original diagnosis above. Per institutional
re-read policy, the re-read interpretation is authoritative for
treatment planning.

H. Okafor, MD — electronically signed 2025-03-07
```

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/notes/2025-03-12__molecular_pathology.txt`:

```
MOLECULAR PATHOLOGY REPORT
Specimen: Right lower lobe core biopsy (re-read NSCLC adenocarcinoma)
Test: Comprehensive Genomic Profiling (CGP) panel
Date reported: 2025-03-12

RESULTS
- EGFR: no actionable mutation
- KRAS: G12C mutation detected (variant allele frequency 32%)
- ALK: no rearrangement
- ROS1: no rearrangement
- BRAF: wild-type
- PD-L1 (22C3): tumor proportion score 60%

CLINICAL INTERPRETATION
Findings consistent with primary pulmonary adenocarcinoma. KRAS G12C
identified, candidate for sotorasib or adagrasib. High PD-L1 supports
consideration of immunotherapy.

D. Kapoor, MD — Molecular Pathology — electronically signed 2025-03-12
```

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/notes/2025-03-18__oncology_progress.txt`:

```
THORACIC ONCOLOGY PROGRESS NOTE
Provider: M. Singh, MD — Hematology/Oncology
Encounter date: 2025-03-18

DIAGNOSIS
Stage IIIA NSCLC, adenocarcinoma subtype, KRAS G12C, PD-L1 60%.

INTERVAL HISTORY
Patient returns following pathology re-read and molecular profiling.
The original biopsy was initially called small-cell, but re-read with
immunohistochemistry on 2025-03-07 revised the diagnosis to
adenocarcinoma. Per institutional policy and the addendum text, the
re-read is authoritative. Treatment planning proceeds on that basis.

ASSESSMENT AND PLAN
1. Stage IIIA NSCLC adenocarcinoma — confirmed. Treatment plan adjusted
   from initial small-cell-protocol planning to NSCLC concurrent
   chemoradiation. Note: prior plan documents from 2025-02-28 to 2025-03-06
   referenced SCLC; those have been amended in the chart following the
   re-read.
2. PD-L1 60%, candidate for consolidation immunotherapy.
3. KRAS G12C — at this point not actionable in stage III, but documented
   for future relevance.

PLAN
- Begin concurrent chemoradiation per stage IIIA NSCLC protocol.
- Repeat imaging in 6 weeks.
- Follow up in clinic in 2 weeks.

M. Singh, MD — electronically signed 2025-03-18
```

- [ ] **Step 6: Create OMOP files**

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/omop/conditions.json`:

```json
[
  { "row_id": 5201, "concept_id": 4115276, "concept_name": "Malignant neoplasm of lower lobe, right bronchus or lung", "icd10cm": "C34.31", "status": "active", "date": "2025-02-28" }
]
```

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/omop/procedures.json`:

```json
[
  { "row_id": 6201, "concept_id": 4096774, "concept_name": "Computed tomography of thorax with contrast", "cpt": "71260", "procedure_date": "2025-02-14", "provider_specialty": "Radiology" },
  { "row_id": 6202, "concept_id": 4321756, "concept_name": "CT-guided lung biopsy", "cpt": "32408", "procedure_date": "2025-02-25", "provider_specialty": "Interventional Radiology" }
]
```

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/omop/measurements.json`:

```json
[
  { "row_id": 7201, "concept_id": 3013762, "concept_name": "Body weight", "value": 78.2, "unit": "kg", "date": "2025-02-14" },
  { "row_id": 7202, "concept_id": 3024171, "concept_name": "Hemoglobin", "value": 11.4, "unit": "g/dL", "ref_low": 13.5, "ref_high": 17.5, "abnormal": "low", "date": "2025-02-14" }
]
```

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/omop/drugs.json`:

```json
[]
```

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/omop/observations.json`:

```json
[
  { "row_id": 9201, "concept_id": 4275495, "concept_name": "Smoking status", "value": "Current smoker, 50 pack-years", "date": "2025-02-14" }
]
```

Write `chart-review-platform/corpus/patients/patient_confirmed_reread_01/omop/encounters.json`:

```json
[
  { "row_id": 10201, "encounter_id": "enc_6201", "type": "Outpatient", "department": "Hematology/Oncology", "primary_provider": "M. Singh, MD", "start_date": "2025-03-18", "end_date": "2025-03-18" }
]
```

- [ ] **Step 7: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_confirmed_reread_01.py -v
```

Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/corpus/patients/patient_confirmed_reread_01 chart-review-platform/lib/tests/test_patient_confirmed_reread_01.py
git commit -m "Add hand-crafted patient_confirmed_reread_01

Original surgical pathology report calls SCLC based on initial H&E
morphology; pathologist re-read addendum with immunohistochemistry
calls NSCLC adenocarcinoma. Tests the manual's re-read rule and the
new contradicting_evidence contract field — agent must answer
pathology_lung_primary=nsclc AND surface the original SCLC reading
as contradicting_evidence."
```

---

## Task 4c: `patient_probable_cytology_01`

Tests the new `is_applicable_when` gate. No surgical/biopsy pathology so `pathology_report_present='no'` → `pathology_lung_primary` is N/A. Cytology FNA report supports lung primary so the new `cytology_supports_lung_primary` field becomes applicable + answered `yes`. Final: `probable` (via clinical-diagnosis path).

**Files:**
- Create: `chart-review-platform/corpus/patients/patient_probable_cytology_01/meta.json`
- Create: `chart-review-platform/corpus/patients/patient_probable_cytology_01/ground_truth.json`
- Create: 4 notes including a cytology FNA report
- Create: 6 OMOP `.json` files
- Create: `chart-review-platform/lib/tests/test_patient_probable_cytology_01.py`

- [ ] **Step 1: Write the assertion test**

Create `chart-review-platform/lib/tests/test_patient_probable_cytology_01.py`:

```python
"""Hand-crafted patient: cytology fallback exercises is_applicable_when.

No surgical or biopsy pathology — pathology_report_present='no' so
pathology_lung_primary is gated to not_applicable. Cytology FNA report
supports lung primary so cytology_supports_lung_primary (the new gated
field) is applicable and answered 'yes'.
"""

from __future__ import annotations

import json
from pathlib import Path

from chart_review.corpus import grep_notes, load_ground_truth
from chart_review.derivation import compute_applicability, evaluate_all

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"
PID = "patient_probable_cytology_01"


def test_ground_truth_is_probable():
    gt = load_ground_truth(CORPUS, PID)
    assert gt["lung_cancer_status"] == "probable"
    assert gt["leaf_answers"]["pathology_report_present"] == "no"
    assert gt["leaf_answers"]["cytology_supports_lung_primary"] == "yes"


def test_pathology_lung_primary_is_gated_off():
    gt = load_ground_truth(CORPUS, PID)
    assert gt["applicability"].get("pathology_lung_primary") == "not_applicable"


def test_notes_contain_cytology_language():
    hits = grep_notes(CORPUS, PID, r"cytolog|FNA|fine.needle aspiration")
    assert len(hits) > 0


def test_applicability_matches_gate():
    """compute_applicability over leaf_answers should mark the gated fields N/A."""
    gt = load_ground_truth(CORPUS, PID)
    compiled = json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())
    appl = compute_applicability(compiled, gt["leaf_answers"])
    assert appl["pathology_lung_primary"] == "not_applicable"
    assert appl["cytology_supports_lung_primary"] == "applicable"


def test_internal_consistency():
    gt = load_ground_truth(CORPUS, PID)
    compiled = json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_probable_cytology_01.py -v
```

Expected: FAIL — patient directory does not exist.

- [ ] **Step 3: Create `meta.json`**

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/meta.json`:

```json
{
  "patient_id": "patient_probable_cytology_01",
  "category": "probable",
  "demographics": { "age": 81, "sex": "F", "region": "Mountain West" },
  "smoking": "Former smoker, 40 pack-years, quit 2008; on home oxygen for COPD",
  "index_date": "2025-06-04",
  "doc_types": ["ct_chest", "pulmonology_consult", "cytology_fna", "oncology_progress"],
  "generated_by": "hand"
}
```

- [ ] **Step 4: Create `ground_truth.json`**

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/ground_truth.json`:

```json
{
  "patient_id": "patient_probable_cytology_01",
  "category": "probable",
  "lung_cancer_status": "probable",
  "leaf_answers": {
    "pathology_report_present": "no",
    "pathology_lung_primary": "not_applicable",
    "cytology_supports_lung_primary": "yes",
    "imaging_lung_lesion": "yes",
    "oncologist_lung_cancer_diagnosis_in_note": "yes",
    "icd_lung_cancer_present": "yes"
  },
  "applicability": {
    "pathology_lung_primary": "not_applicable",
    "cytology_supports_lung_primary": "applicable"
  },
  "expected_contradicting_evidence_fields": [],
  "difficulty": "hard",
  "difficulty_notes": "Hand-crafted. Patient deemed too high-risk for core biopsy; only cytology FNA was obtained. pathology_report_present='no' so pathology_lung_primary is gated to not_applicable. cytology_supports_lung_primary becomes applicable and is 'yes' (FNA reports adenocarcinoma cells). Tests the new is_applicable_when contract field end-to-end."
}
```

- [ ] **Step 5: Write the four notes**

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/notes/2025-05-08__ct_chest.txt`:

```
CT CHEST WITH CONTRAST
Date of examination: 2025-05-08
Indication: 81F, COPD, new opacity on chest x-ray

FINDINGS
A 3.1 cm mass is identified in the right upper lobe with spiculated
margins and overlying pleural retraction. Severe centrilobular emphysema
is noted in both upper lobes. No mediastinal or hilar adenopathy. No
pleural effusion.

IMPRESSION
1. 3.1 cm spiculated right upper lobe mass, suspicious for primary lung
   malignancy.
2. Severe emphysema.

C. Donovan, MD — Radiology — electronically signed 2025-05-08
```

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/notes/2025-05-15__pulmonology_consult.txt`:

```
PULMONOLOGY CONSULTATION
Provider: F. Iqbal, MD — Pulmonary and Critical Care
Encounter date: 2025-05-15

REASON FOR CONSULTATION
3.1 cm right upper lobe mass on CT in an 81-year-old with severe COPD
on home oxygen. Tissue diagnosis requested.

ASSESSMENT
The patient's pulmonary reserve is severely limited (FEV1 32% predicted
on most recent PFTs). Core biopsy of a right upper lobe mass in this
setting carries substantial risk of pneumothorax that we judge
prohibitive. After multidisciplinary discussion with thoracic surgery
and interventional radiology, we will proceed with the lower-risk
endobronchial transbronchial fine-needle aspiration (FNA) cytology and
defer surgical or core biopsy.

PLAN
1. EBUS with FNA cytology of the right upper lobe mass.
2. If cytology supports primary lung malignancy and clinical context
   confirms, proceed to oncology referral.
3. No core biopsy or surgical pathology will be obtained given pulmonary
   risk profile.

F. Iqbal, MD — electronically signed 2025-05-15
```

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/notes/2025-05-22__cytology_fna.txt`:

```
CYTOLOGY REPORT
Specimen: Right upper lobe mass, EBUS fine-needle aspiration (FNA)
Specimen received: 2025-05-22
Pathologist: A. Whitfield, MD — Cytopathology

CLINICAL HISTORY
81-year-old with 3.1 cm right upper lobe mass and severe COPD; surgical
or core biopsy deferred for pulmonary risk.

GROSS / SLIDE DESCRIPTION
Multiple aspirate smears and one cell block, all from the right upper
lobe target lesion.

MICROSCOPIC DESCRIPTION
Aspirate is cellular and shows clusters and three-dimensional groups of
atypical epithelial cells with enlarged nuclei, prominent nucleoli, and
a glandular architecture. Background necrotic debris is present.

INTERPRETATION
Right upper lobe FNA, cytology: ATYPICAL CELLS, MOST CONSISTENT WITH
ADENOCARCINOMA, FAVOR PRIMARY LUNG ORIGIN.

NOTE
This is a cytology specimen only — no surgical or core biopsy tissue
was obtained. Per the chart-review manual definition, this report does
not satisfy 'pathology report present' (which requires a surgical or
biopsy specimen interpreted by a credentialed pathologist) but does
support cytology-confirmed lung primary.

A. Whitfield, MD — electronically signed 2025-05-22
```

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/notes/2025-06-04__oncology_progress.txt`:

```
THORACIC ONCOLOGY PROGRESS NOTE
Provider: G. Adeyemi, MD — Hematology/Oncology
Encounter date: 2025-06-04

DIAGNOSIS
Lung cancer, cytology-supported (adenocarcinoma favored), staged
clinically as cT2aN0M0 (stage IB).

ASSESSMENT
Severe COPD precluded core biopsy. EBUS FNA cytology favors
adenocarcinoma of pulmonary origin. Clinical impression is primary
lung cancer; surgical or core tissue is not obtainable. We will
proceed with stereotactic body radiation therapy (SBRT) as definitive
treatment, given inoperability and adequate cytology + imaging
correlation. Patient understands and is in agreement.

PLAN
1. SBRT consultation, target start within 2 weeks.
2. Surveillance imaging post-SBRT at 3 months.
3. No further tissue sampling planned.

G. Adeyemi, MD — electronically signed 2025-06-04
```

- [ ] **Step 6: Create OMOP files**

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/omop/conditions.json`:

```json
[
  { "row_id": 5301, "concept_id": 255573, "concept_name": "COPD", "icd10cm": "J44.9", "status": "active", "date": "2014-02-19" },
  { "row_id": 5302, "concept_id": 4115276, "concept_name": "Malignant neoplasm of upper lobe, right bronchus or lung", "icd10cm": "C34.11", "status": "active", "date": "2025-05-22" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/omop/procedures.json`:

```json
[
  { "row_id": 6301, "concept_id": 4096774, "concept_name": "Computed tomography of thorax with contrast", "cpt": "71260", "procedure_date": "2025-05-08", "provider_specialty": "Radiology" },
  { "row_id": 6302, "concept_id": 4035768, "concept_name": "EBUS with transbronchial FNA", "cpt": "31652", "procedure_date": "2025-05-22", "provider_specialty": "Pulmonology" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/omop/measurements.json`:

```json
[
  { "row_id": 7301, "concept_id": 3024171, "concept_name": "Hemoglobin", "value": 12.1, "unit": "g/dL", "date": "2025-05-15" },
  { "row_id": 7302, "concept_id": 4187919, "concept_name": "FEV1 percent predicted", "value": 32, "unit": "%", "date": "2025-04-22" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/omop/drugs.json`:

```json
[
  { "row_id": 8301, "concept_id": 1115008, "concept_name": "Tiotropium", "rxnorm": "274535", "status": "active", "date_start": "2014-02-19" },
  { "row_id": 8302, "concept_id": 1124957, "concept_name": "Albuterol inhaler", "rxnorm": "329498", "status": "active", "date_start": "2014-02-19" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/omop/observations.json`:

```json
[
  { "row_id": 9301, "concept_id": 4275495, "concept_name": "Smoking status", "value": "Former smoker, 40 pack-years, quit 2008", "date": "2025-05-15" }
]
```

Write `chart-review-platform/corpus/patients/patient_probable_cytology_01/omop/encounters.json`:

```json
[
  { "row_id": 10301, "encounter_id": "enc_7301", "type": "Outpatient", "department": "Pulmonology", "primary_provider": "F. Iqbal, MD", "start_date": "2025-05-15", "end_date": "2025-05-15" },
  { "row_id": 10302, "encounter_id": "enc_7302", "type": "Outpatient", "department": "Hematology/Oncology", "primary_provider": "G. Adeyemi, MD", "start_date": "2025-06-04", "end_date": "2025-06-04" }
]
```

- [ ] **Step 7: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_probable_cytology_01.py -v
```

Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/corpus/patients/patient_probable_cytology_01 chart-review-platform/lib/tests/test_patient_probable_cytology_01.py
git commit -m "Add hand-crafted patient_probable_cytology_01

No surgical or core biopsy (deferred for COPD risk) — only EBUS FNA
cytology. pathology_report_present='no' gates pathology_lung_primary
to not_applicable. cytology_supports_lung_primary becomes applicable
and answers 'yes'. Tests the new is_applicable_when contract field
end-to-end on a clinically realistic scenario."
```

---

## Task 4d: `patient_icd_z85_coexist_01`

Tests that `icd_lung_cancer_present` correctly answers `yes` based on a C34.10 problem-list code even when Z85.118 (personal-history of lung cancer) co-exists. No qualifying pathology / imaging / oncologist note. Final: `probable` (ICD path only).

**Files:**
- Create: `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/meta.json`
- Create: `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/ground_truth.json`
- Create: 3–4 notes (admin / scheduling-context, no clinical lung cancer narrative)
- Create: 6 OMOP `.json` files
- Create: `chart-review-platform/lib/tests/test_patient_icd_z85_coexist_01.py`

- [ ] **Step 1: Write the assertion test**

Create `chart-review-platform/lib/tests/test_patient_icd_z85_coexist_01.py`:

```python
"""Hand-crafted patient: C34.10 + Z85.118 coexistence.

A C34.10 code on the recent encounter problem list AND a legacy Z85.118
personal-history code in conditions. icd_lung_cancer_present must
answer 'yes' based on C34.10; Z85.118 alone would be 'no'.
No qualifying pathology, imaging, or oncologist note. Final: probable.
"""

from __future__ import annotations

import json
from pathlib import Path

from chart_review.corpus import load_ground_truth, omop_query
from chart_review.derivation import evaluate_all

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"
PID = "patient_icd_z85_coexist_01"


def test_ground_truth_icd_yes_status_probable():
    gt = load_ground_truth(CORPUS, PID)
    assert gt["lung_cancer_status"] == "probable"
    assert gt["leaf_answers"]["icd_lung_cancer_present"] == "yes"
    assert gt["leaf_answers"]["pathology_report_present"] == "no"
    assert gt["leaf_answers"]["imaging_lung_lesion"] == "no"


def test_omop_has_both_c34_and_z85():
    c34 = omop_query(CORPUS, PID, "conditions", {"icd10cm_prefix": "C34"})
    z85 = omop_query(CORPUS, PID, "conditions", {"icd10cm": "Z85.118"})
    assert len(c34) >= 1
    assert len(z85) >= 1


def test_internal_consistency():
    gt = load_ground_truth(CORPUS, PID)
    compiled = json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_icd_z85_coexist_01.py -v
```

Expected: FAIL — patient directory does not exist.

- [ ] **Step 3: Create `meta.json`**

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/meta.json`:

```json
{
  "patient_id": "patient_icd_z85_coexist_01",
  "category": "icd_only",
  "demographics": { "age": 67, "sex": "M", "region": "Midwest" },
  "smoking": "Former smoker, 30 pack-years, quit 2010",
  "index_date": "2025-07-21",
  "doc_types": ["er_visit", "discharge_summary", "pcp_followup"],
  "generated_by": "hand"
}
```

- [ ] **Step 4: Create `ground_truth.json`**

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/ground_truth.json`:

```json
{
  "patient_id": "patient_icd_z85_coexist_01",
  "category": "icd_only",
  "lung_cancer_status": "probable",
  "leaf_answers": {
    "pathology_report_present": "no",
    "pathology_lung_primary": "not_applicable",
    "cytology_supports_lung_primary": "no",
    "imaging_lung_lesion": "no",
    "oncologist_lung_cancer_diagnosis_in_note": "no",
    "icd_lung_cancer_present": "yes"
  },
  "applicability": {
    "pathology_lung_primary": "not_applicable",
    "cytology_supports_lung_primary": "applicable"
  },
  "expected_contradicting_evidence_fields": [],
  "difficulty": "hard",
  "difficulty_notes": "Hand-crafted. C34.10 code on recent ER discharge problem list (added by an internist for billing during a non-oncology admission). Legacy Z85.118 personal-history code from prior chart from a different visit. No surgical pathology, no suspicious imaging in the lookback window, no oncologist note in the lookback window. Final = probable solely via the icd_lung_cancer_present='yes' path. Tests that the agent counts C34.10 even when Z85.118 also appears."
}
```

- [ ] **Step 5: Write three notes**

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/notes/2025-07-09__er_visit.txt`:

```
EMERGENCY DEPARTMENT NOTE
Provider: V. Park, MD
Encounter date: 2025-07-09 19:42

CHIEF COMPLAINT
Pleuritic right-sided chest pain after lifting heavy boxes.

HISTORY OF PRESENT ILLNESS
67-year-old man presents with sharp right-sided chest pain that began
after moving boxes earlier today. Pain is reproduced on palpation. No
shortness of breath. No cough. No hemoptysis. No fever.

ASSESSMENT AND PLAN
Musculoskeletal chest wall pain. Chest x-ray showed no acute pulmonary
process. ECG and troponin reassuring. Discharge home with NSAIDs and
PCP follow-up.

V. Park, MD — electronically signed 2025-07-09 21:18
```

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/notes/2025-07-09__discharge_summary.txt`:

```
EMERGENCY DEPARTMENT DISCHARGE SUMMARY
Provider: V. Park, MD
Discharge date: 2025-07-09 21:30

DISCHARGE DIAGNOSES
1. Musculoskeletal chest wall pain.
2. Lung cancer (C34.10) — chronic, problem-list condition (treating
   physician on file).
3. Personal history of malignant neoplasm of bronchus and lung
   (Z85.118).
4. Tobacco use, former.

NOTE
Patient's chronic lung cancer (C34.10) was carried over to this
admission's problem list automatically per institutional billing
practice; no acute oncologic intervention performed during this visit.
Patient counseled to follow up with oncology and PCP.

V. Park, MD — electronically signed 2025-07-09 21:45
```

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/notes/2025-07-21__pcp_followup.txt`:

```
PRIMARY CARE FOLLOW-UP
Provider: D. Lin, MD — Family Medicine
Encounter date: 2025-07-21

INTERVAL HISTORY
67-year-old man returns following ED visit for musculoskeletal chest
pain on 2025-07-09. Pain has fully resolved.

PROBLEM LIST REVIEW
- Hypertension, controlled.
- Tobacco use, former.
- Chronic lung condition coded on prior charts (Z85.118 personal history
  added during a 2017 hospitalization; C34.10 carried forward from
  oncology problem list).

ASSESSMENT
Musculoskeletal chest pain, resolved. Continue current medications.
Routine annual examination.

D. Lin, MD — electronically signed 2025-07-21
```

- [ ] **Step 6: Create OMOP files**

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/omop/conditions.json`:

```json
[
  { "row_id": 5401, "concept_id": 320128, "concept_name": "Essential hypertension", "icd10cm": "I10", "status": "active", "date": "2014-08-04" },
  { "row_id": 5402, "concept_id": 4193869, "concept_name": "Personal history of malignant neoplasm of bronchus and lung", "icd10cm": "Z85.118", "status": "active", "date": "2017-11-03" },
  { "row_id": 5403, "concept_id": 4115276, "concept_name": "Malignant neoplasm of unspecified part of bronchus or lung", "icd10cm": "C34.10", "status": "active", "date": "2025-07-09" },
  { "row_id": 5404, "concept_id": 4119911, "concept_name": "Chest wall pain", "icd10cm": "M79.81", "status": "resolved", "date": "2025-07-09" }
]
```

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/omop/procedures.json`:

```json
[
  { "row_id": 6401, "concept_id": 4096774, "concept_name": "Chest x-ray, single view", "cpt": "71045", "procedure_date": "2025-07-09", "provider_specialty": "Radiology" }
]
```

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/omop/measurements.json`:

```json
[
  { "row_id": 7401, "concept_id": 3013762, "concept_name": "Body weight", "value": 84.5, "unit": "kg", "date": "2025-07-21" }
]
```

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/omop/drugs.json`:

```json
[
  { "row_id": 8401, "concept_id": 1308216, "concept_name": "Lisinopril 10 MG Oral Tablet", "rxnorm": "311353", "status": "active", "date_start": "2014-08-04" },
  { "row_id": 8402, "concept_id": 1115008, "concept_name": "Ibuprofen 600 MG Oral Tablet", "rxnorm": "197807", "status": "active", "date_start": "2025-07-09" }
]
```

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/omop/observations.json`:

```json
[
  { "row_id": 9401, "concept_id": 4275495, "concept_name": "Smoking status", "value": "Former smoker, 30 pack-years, quit 2010", "date": "2025-07-21" }
]
```

Write `chart-review-platform/corpus/patients/patient_icd_z85_coexist_01/omop/encounters.json`:

```json
[
  { "row_id": 10401, "encounter_id": "enc_8401", "type": "ED", "department": "Emergency", "primary_provider": "V. Park, MD", "start_date": "2025-07-09", "end_date": "2025-07-09" },
  { "row_id": 10402, "encounter_id": "enc_8402", "type": "Outpatient", "department": "Primary Care", "primary_provider": "D. Lin, MD", "start_date": "2025-07-21", "end_date": "2025-07-21" }
]
```

- [ ] **Step 7: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_patient_icd_z85_coexist_01.py -v
```

Expected: PASS, 3 tests.

- [ ] **Step 8: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/corpus/patients/patient_icd_z85_coexist_01 chart-review-platform/lib/tests/test_patient_icd_z85_coexist_01.py
git commit -m "Add hand-crafted patient_icd_z85_coexist_01

C34.10 code on recent ED encounter problem list AND Z85.118 legacy
personal-history code coexist. No qualifying pathology, no suspicious
imaging in the lookback window, no oncologist note. Tests that
icd_lung_cancer_present='yes' (based on C34.10) even when Z85.118
also appears. Final = probable via the ICD path only."
```

---

## Task 5: Patient seeds + corpus index

**Files:**
- Create: `chart-review-platform/tools/patient_seeds.yaml`
- Modify: `chart-review-platform/corpus/index.json`

- [ ] **Step 1: Create `tools/` directory and write `patient_seeds.yaml`**

```sh
mkdir -p "Studies/Chart Review Agents/chart-review-platform/tools"
```

Write `chart-review-platform/tools/patient_seeds.yaml`:

```yaml
# Source-of-truth list of all 20 corpus patients.
# Hand-crafted patients have hand_crafted: true and committed .txt notes.
# API-generated patients have hand_crafted: false and a structured spec the
# generation script consumes.

# ---- 5 hand-crafted designed-to-fail patients ----

- id: patient_neg_hard_01
  category: negative
  difficulty: hard
  hand_crafted: true
  headline: "71M, smoking history, hedged language across pulm/CT/ED notes; final absent."

- id: patient_probable_fhx_01
  category: probable
  difficulty: hard
  hand_crafted: true
  headline: "64F, never-smoker with secondhand exposure; family history of lung cancer + Z85.118 decoys; oncologist active diagnosis; final probable."

- id: patient_confirmed_reread_01
  category: confirmed_nsclc
  difficulty: hard
  hand_crafted: true
  headline: "73M, original path SCLC, re-read addendum NSCLC adenocarcinoma; final confirmed nsclc with contradicting_evidence."

- id: patient_probable_cytology_01
  category: probable
  difficulty: hard
  hand_crafted: true
  headline: "81F, COPD precludes core biopsy; cytology FNA favors adenocarcinoma; tests is_applicable_when cytology gate; final probable."

- id: patient_icd_z85_coexist_01
  category: icd_only
  difficulty: hard
  hand_crafted: true
  headline: "67M, C34.10 + Z85.118 coexist on chart; no path/imaging/oncologist note; final probable via ICD path."


# ---- 15 API-generated easy patients ----

# 4 confirmed-NSCLC
- id: patient_easy_nsclc_01
  category: confirmed_nsclc
  difficulty: easy
  hand_crafted: false
  age: 68
  sex: F
  smoking: 30 pack-years, quit 2018
  region: Midwest
  presenting_complaint: hemoptysis
  index_date: 2024-12-09
  notes:
    - { type: ct_chest, date: 2024-11-12 }
    - { type: surgical_pathology, date: 2024-11-26 }
    - { type: oncology_progress, date: 2024-12-09 }
    - { type: pcp_followup, date: 2025-01-15 }
  target_leaf_answers:
    pathology_report_present: "yes"
    pathology_lung_primary: "nsclc"
    imaging_lung_lesion: "yes"
    oncologist_lung_cancer_diagnosis_in_note: "yes"
    icd_lung_cancer_present: "yes"

- id: patient_easy_nsclc_02
  category: confirmed_nsclc
  difficulty: easy
  hand_crafted: false
  age: 75
  sex: M
  smoking: 60 pack-years, current
  region: Pacific Northwest
  presenting_complaint: chronic cough and weight loss
  index_date: 2025-04-22
  notes:
    - { type: ct_chest, date: 2025-03-04 }
    - { type: surgical_pathology, date: 2025-03-25 }
    - { type: oncology_progress, date: 2025-04-22 }
  target_leaf_answers:
    pathology_report_present: "yes"
    pathology_lung_primary: "nsclc"
    imaging_lung_lesion: "yes"
    oncologist_lung_cancer_diagnosis_in_note: "yes"
    icd_lung_cancer_present: "yes"

- id: patient_easy_nsclc_03
  category: confirmed_nsclc
  difficulty: easy
  hand_crafted: false
  age: 60
  sex: F
  smoking: 22 pack-years, quit 2020
  region: Northeast
  presenting_complaint: incidental nodule on routine chest x-ray
  index_date: 2024-08-14
  notes:
    - { type: ct_chest, date: 2024-06-30 }
    - { type: pulmonology_consult, date: 2024-07-08 }
    - { type: surgical_pathology, date: 2024-07-21 }
    - { type: oncology_progress, date: 2024-08-14 }
  target_leaf_answers:
    pathology_report_present: "yes"
    pathology_lung_primary: "nsclc"
    imaging_lung_lesion: "yes"
    oncologist_lung_cancer_diagnosis_in_note: "yes"
    icd_lung_cancer_present: "yes"

- id: patient_easy_nsclc_04
  category: confirmed_nsclc
  difficulty: easy
  hand_crafted: false
  age: 82
  sex: M
  smoking: 45 pack-years, quit 2002
  region: Southeast
  presenting_complaint: shortness of breath, weight loss
  index_date: 2025-02-11
  notes:
    - { type: ct_chest, date: 2025-01-08 }
    - { type: surgical_pathology, date: 2025-01-22 }
    - { type: oncology_progress, date: 2025-02-11 }
    - { type: pcp_followup, date: 2025-03-04 }
  target_leaf_answers:
    pathology_report_present: "yes"
    pathology_lung_primary: "nsclc"
    imaging_lung_lesion: "yes"
    oncologist_lung_cancer_diagnosis_in_note: "yes"
    icd_lung_cancer_present: "yes"


# 3 SCLC
- id: patient_easy_sclc_01
  category: sclc
  difficulty: easy
  hand_crafted: false
  age: 67
  sex: M
  smoking: 55 pack-years, current
  region: Midwest
  presenting_complaint: cough, hemoptysis, weight loss
  index_date: 2024-09-30
  notes:
    - { type: ct_chest, date: 2024-08-22 }
    - { type: surgical_pathology, date: 2024-09-05 }
    - { type: oncology_progress, date: 2024-09-30 }
  target_leaf_answers:
    pathology_report_present: "yes"
    pathology_lung_primary: "sclc"
    imaging_lung_lesion: "yes"
    oncologist_lung_cancer_diagnosis_in_note: "yes"
    icd_lung_cancer_present: "yes"

- id: patient_easy_sclc_02
  category: sclc
  difficulty: easy
  hand_crafted: false
  age: 72
  sex: F
  smoking: 40 pack-years, quit 2014
  region: West
  presenting_complaint: SVC syndrome
  index_date: 2025-05-20
  notes:
    - { type: ct_chest, date: 2025-04-09 }
    - { type: surgical_pathology, date: 2025-04-25 }
    - { type: oncology_progress, date: 2025-05-20 }
  target_leaf_answers:
    pathology_report_present: "yes"
    pathology_lung_primary: "sclc"
    imaging_lung_lesion: "yes"
    oncologist_lung_cancer_diagnosis_in_note: "yes"
    icd_lung_cancer_present: "yes"

- id: patient_easy_sclc_03
  category: sclc
  difficulty: easy
  hand_crafted: false
  age: 65
  sex: M
  smoking: 50 pack-years, current
  region: South
  presenting_complaint: paraneoplastic SIADH
  index_date: 2025-09-12
  notes:
    - { type: ct_chest, date: 2025-08-04 }
    - { type: surgical_pathology, date: 2025-08-19 }
    - { type: oncology_progress, date: 2025-09-12 }
    - { type: pcp_followup, date: 2025-10-08 }
  target_leaf_answers:
    pathology_report_present: "yes"
    pathology_lung_primary: "sclc"
    imaging_lung_lesion: "yes"
    oncologist_lung_cancer_diagnosis_in_note: "yes"
    icd_lung_cancer_present: "yes"


# 2 probable
- id: patient_easy_probable_01
  category: probable
  difficulty: easy
  hand_crafted: false
  age: 70
  sex: F
  smoking: 25 pack-years, quit 2005
  region: Northeast
  presenting_complaint: incidental lung mass on CT abdomen for unrelated complaint
  index_date: 2025-01-28
  notes:
    - { type: ct_chest, date: 2024-12-15 }
    - { type: oncology_consult, date: 2025-01-12 }
    - { type: oncology_progress, date: 2025-01-28 }
  target_leaf_answers:
    pathology_report_present: "no"
    pathology_lung_primary: "not_applicable"
    cytology_supports_lung_primary: "no"
    imaging_lung_lesion: "yes"
    oncologist_lung_cancer_diagnosis_in_note: "yes"
    icd_lung_cancer_present: "yes"

- id: patient_easy_probable_02
  category: probable
  difficulty: easy
  hand_crafted: false
  age: 78
  sex: M
  smoking: 40 pack-years, quit 1998
  region: Midwest
  presenting_complaint: cough, declining functional status
  index_date: 2025-06-30
  notes:
    - { type: ct_chest, date: 2025-05-22 }
    - { type: pulmonology_consult, date: 2025-06-10 }
    - { type: oncology_progress, date: 2025-06-30 }
  target_leaf_answers:
    pathology_report_present: "no"
    pathology_lung_primary: "not_applicable"
    cytology_supports_lung_primary: "no"
    imaging_lung_lesion: "yes"
    oncologist_lung_cancer_diagnosis_in_note: "yes"
    icd_lung_cancer_present: "no"


# 2 ICD-only
- id: patient_easy_icd_01
  category: icd_only
  difficulty: easy
  hand_crafted: false
  age: 69
  sex: M
  smoking: 28 pack-years, quit 2012
  region: South
  presenting_complaint: routine wellness visit
  index_date: 2025-04-08
  notes:
    - { type: pcp_visit, date: 2025-03-12 }
    - { type: er_visit, date: 2025-03-30 }
    - { type: pcp_followup, date: 2025-04-08 }
  target_leaf_answers:
    pathology_report_present: "no"
    pathology_lung_primary: "not_applicable"
    cytology_supports_lung_primary: "no"
    imaging_lung_lesion: "no"
    oncologist_lung_cancer_diagnosis_in_note: "no"
    icd_lung_cancer_present: "yes"

- id: patient_easy_icd_02
  category: icd_only
  difficulty: easy
  hand_crafted: false
  age: 74
  sex: F
  smoking: 30 pack-years, quit 2008
  region: West
  presenting_complaint: orthopedic admission
  index_date: 2024-11-04
  notes:
    - { type: er_visit, date: 2024-10-22 }
    - { type: discharge_summary, date: 2024-10-26 }
    - { type: pcp_followup, date: 2024-11-04 }
  target_leaf_answers:
    pathology_report_present: "no"
    pathology_lung_primary: "not_applicable"
    cytology_supports_lung_primary: "no"
    imaging_lung_lesion: "no"
    oncologist_lung_cancer_diagnosis_in_note: "no"
    icd_lung_cancer_present: "yes"


# 4 negative
- id: patient_easy_neg_01
  category: negative
  difficulty: easy
  hand_crafted: false
  age: 58
  sex: F
  smoking: never
  region: Northeast
  presenting_complaint: routine annual exam
  index_date: 2025-07-15
  notes:
    - { type: pcp_visit, date: 2025-07-15 }
    - { type: pcp_followup, date: 2025-10-21 }
  target_leaf_answers:
    pathology_report_present: "no"
    pathology_lung_primary: "not_applicable"
    cytology_supports_lung_primary: "no"
    imaging_lung_lesion: "no"
    oncologist_lung_cancer_diagnosis_in_note: "no"
    icd_lung_cancer_present: "no"

- id: patient_easy_neg_02
  category: negative
  difficulty: easy
  hand_crafted: false
  age: 62
  sex: M
  smoking: 12 pack-years, quit 2000
  region: Pacific Northwest
  presenting_complaint: knee pain
  index_date: 2025-01-19
  notes:
    - { type: pcp_visit, date: 2025-01-19 }
    - { type: er_visit, date: 2025-04-04 }
    - { type: pcp_followup, date: 2025-05-12 }
  target_leaf_answers:
    pathology_report_present: "no"
    pathology_lung_primary: "not_applicable"
    cytology_supports_lung_primary: "no"
    imaging_lung_lesion: "no"
    oncologist_lung_cancer_diagnosis_in_note: "no"
    icd_lung_cancer_present: "no"

- id: patient_easy_neg_03
  category: negative
  difficulty: easy
  hand_crafted: false
  age: 55
  sex: F
  smoking: never
  region: Midwest
  presenting_complaint: thyroid disease management
  index_date: 2025-09-22
  notes:
    - { type: pcp_visit, date: 2025-09-22 }
    - { type: endocrinology_consult, date: 2025-10-14 }
  target_leaf_answers:
    pathology_report_present: "no"
    pathology_lung_primary: "not_applicable"
    cytology_supports_lung_primary: "no"
    imaging_lung_lesion: "no"
    oncologist_lung_cancer_diagnosis_in_note: "no"
    icd_lung_cancer_present: "no"

- id: patient_easy_neg_04
  category: negative
  difficulty: easy
  hand_crafted: false
  age: 80
  sex: M
  smoking: 35 pack-years, quit 1990
  region: South
  presenting_complaint: chronic atrial fibrillation
  index_date: 2025-08-06
  notes:
    - { type: pcp_visit, date: 2025-08-06 }
    - { type: cardiology_consult, date: 2025-08-29 }
    - { type: pcp_followup, date: 2025-10-12 }
  target_leaf_answers:
    pathology_report_present: "no"
    pathology_lung_primary: "not_applicable"
    cytology_supports_lung_primary: "no"
    imaging_lung_lesion: "no"
    oncologist_lung_cancer_diagnosis_in_note: "no"
    icd_lung_cancer_present: "no"
```

- [ ] **Step 2: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/tools/patient_seeds.yaml
git commit -m "Add patient_seeds.yaml — source-of-truth for the 20-patient corpus

5 hand-crafted entries for the designed-to-fail patients (already in
corpus/patients/) and 15 structured seeds for API-generated easy
patients. The generation script (next task) consumes this file."
```

---

## Task 6: Generation script — hand-crafted code path

The generation script's first job: walk hand-crafted seeds, validate that committed `.txt` notes exist, and emit `meta.json` + `ground_truth.json` derived from the seeds *if not already committed* (the 5 hand-crafted patients in Tasks 3 and 4a–4d already committed these). The script should be idempotent: running it for already-committed hand-crafted patients changes nothing.

**Files:**
- Create: `chart-review-platform/tools/generate_corpus.py`
- Create: `chart-review-platform/lib/tests/test_generate_corpus.py`

- [ ] **Step 1: Write the failing tests**

Create `chart-review-platform/lib/tests/test_generate_corpus.py`:

```python
"""Tests for tools/generate_corpus.py — hand-crafted code path."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
GEN_SCRIPT = ROOT / "tools" / "generate_corpus.py"


@pytest.fixture()
def gen_module():
    spec = importlib.util.spec_from_file_location("generate_corpus", GEN_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["generate_corpus"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_load_seeds_returns_20(gen_module):
    seeds = gen_module.load_seeds(ROOT / "tools" / "patient_seeds.yaml")
    assert len(seeds) == 20


def test_load_seeds_distribution(gen_module):
    seeds = gen_module.load_seeds(ROOT / "tools" / "patient_seeds.yaml")
    counts = {}
    for s in seeds:
        counts[s["category"]] = counts.get(s["category"], 0) + 1
    assert counts == {
        "confirmed_nsclc": 5,
        "sclc": 3,
        "probable": 4,
        "icd_only": 3,
        "negative": 5,
    }


def test_hand_crafted_patient_directories_exist(gen_module):
    seeds = gen_module.load_seeds(ROOT / "tools" / "patient_seeds.yaml")
    hand_crafted = [s for s in seeds if s.get("hand_crafted")]
    for s in hand_crafted:
        d = ROOT / "corpus" / "patients" / s["id"]
        assert d.is_dir(), f"Missing hand-crafted patient: {s['id']}"
        assert (d / "meta.json").is_file()
        assert (d / "ground_truth.json").is_file()
        assert (d / "notes").is_dir()
        assert (d / "omop").is_dir()


def test_run_idempotent_on_hand_crafted(gen_module, tmp_path):
    """Running generation on hand-crafted patients should be a no-op."""
    seeds = gen_module.load_seeds(ROOT / "tools" / "patient_seeds.yaml")
    hand_crafted = [s for s in seeds if s.get("hand_crafted")][:1]
    # Snapshot current state of patient_neg_hard_01
    pid = hand_crafted[0]["id"]
    meta_path = ROOT / "corpus" / "patients" / pid / "meta.json"
    before = meta_path.read_text()
    gen_module.process_hand_crafted(ROOT / "corpus", hand_crafted[0])
    after = meta_path.read_text()
    assert before == after  # idempotent
```

- [ ] **Step 2: Run tests to verify they fail**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_generate_corpus.py -v
```

Expected: FAIL — script does not exist.

- [ ] **Step 3: Implement `tools/generate_corpus.py` (hand-crafted path only)**

Write `chart-review-platform/tools/generate_corpus.py`:

```python
#!/usr/bin/env python3
"""Generate the synthetic patient corpus.

Reads tools/patient_seeds.yaml; for each entry:

- hand_crafted: true    — validates that the patient directory + notes exist;
                          regenerates meta.json + ground_truth.json from
                          existing committed files (idempotent — does not
                          overwrite if content unchanged).

- hand_crafted: false   — calls Claude API once per note to produce the
                          notes, then writes meta.json + ground_truth.json
                          + per-table OMOP files. (Implemented in a later
                          task; this version skips API-generated patients
                          with a notice.)

Usage:
    chart-review-platform/.venv/bin/python tools/generate_corpus.py
    chart-review-platform/.venv/bin/python tools/generate_corpus.py --regenerate <patient_id>
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


def load_seeds(seeds_yaml: Path) -> list[dict[str, Any]]:
    return yaml.safe_load(seeds_yaml.read_text())


def process_hand_crafted(corpus_root: Path, seed: dict[str, Any]) -> None:
    """Validate that a hand-crafted patient is fully committed.

    Idempotent — does not overwrite committed files. Raises if required
    files are missing.
    """
    pid = seed["id"]
    pat_dir = corpus_root / "patients" / pid
    if not pat_dir.is_dir():
        raise FileNotFoundError(f"Hand-crafted patient missing: {pat_dir}")
    for required in ("meta.json", "ground_truth.json"):
        if not (pat_dir / required).is_file():
            raise FileNotFoundError(f"{pid} missing {required}")
    if not (pat_dir / "notes").is_dir() or not list((pat_dir / "notes").glob("*.txt")):
        raise FileNotFoundError(f"{pid} has no notes/")
    if not (pat_dir / "omop").is_dir():
        raise FileNotFoundError(f"{pid} has no omop/")


def write_index(corpus_root: Path, seeds: list[dict[str, Any]], model_id: str) -> None:
    """Regenerate corpus/index.json from the seeds + the actually-present files."""
    patients = []
    for s in seeds:
        pid = s["id"]
        meta_path = corpus_root / "patients" / pid / "meta.json"
        if not meta_path.is_file():
            continue  # API-generated and not yet produced
        meta = json.loads(meta_path.read_text())
        patients.append({
            "patient_id": pid,
            "category": meta["category"],
            "difficulty": s["difficulty"],
            "headline": s.get("headline", ""),
        })
    idx = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "model_id": model_id,
        "patients": patients,
    }
    (corpus_root / "index.json").write_text(json.dumps(idx, indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--seeds",
        type=Path,
        default=Path(__file__).resolve().parent / "patient_seeds.yaml",
    )
    p.add_argument(
        "--corpus-root",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "corpus",
    )
    p.add_argument("--regenerate", help="patient_id to force regenerate")
    p.add_argument("--model-id", default="claude-sonnet-4-6")
    args = p.parse_args(argv)

    seeds = load_seeds(args.seeds)
    for s in seeds:
        if s.get("hand_crafted"):
            process_hand_crafted(args.corpus_root, s)
        else:
            print(f"[skip] {s['id']} — API-generated path not yet implemented")
    write_index(args.corpus_root, seeds, args.model_id)
    print(f"corpus/index.json regenerated with {len(seeds)} seeds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_generate_corpus.py -v
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Run the script once to regenerate `index.json`**

```sh
cd "Studies/Chart Review Agents/chart-review-platform"
.venv/bin/python tools/generate_corpus.py
```

Expected output:
```
[skip] patient_easy_nsclc_01 — API-generated path not yet implemented
[skip] patient_easy_nsclc_02 — API-generated path not yet implemented
... (15 lines)
corpus/index.json regenerated with 20 seeds
```

`corpus/index.json` should now list the 5 hand-crafted patients (the API-generated ones are skipped until Task 7).

- [ ] **Step 6: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/tools/generate_corpus.py chart-review-platform/lib/tests/test_generate_corpus.py chart-review-platform/corpus/index.json
git commit -m "Add tools/generate_corpus.py — hand-crafted code path

Validates committed hand-crafted patients and regenerates
corpus/index.json from patient_seeds.yaml. API-generated path is
stubbed (logged as skipped) and lands in the next task."
```

---

## Task 7: Generation script — API-generated code path

Add the Anthropic SDK call branch. The script generates one note at a time per API-generated patient, sequentially (rate-limit-friendly). Each call's prompt embeds the patient seed + the desired ground-truth answers + the note's type and date.

**Files:**
- Modify: `chart-review-platform/tools/generate_corpus.py`
- Modify: `chart-review-platform/lib/pyproject.toml` (add anthropic SDK to dev deps)
- Create: `chart-review-platform/lib/tests/test_generate_corpus_api.py`

- [ ] **Step 1: Add `anthropic` to dev deps**

Modify `chart-review-platform/lib/pyproject.toml`:

```toml
[project.optional-dependencies]
dev = ["pytest>=8", "anthropic>=0.40"]
```

Then re-install:

```sh
cd "Studies/Chart Review Agents/chart-review-platform"
chflags -R nohidden .venv/lib 2>/dev/null
.venv/bin/pip install --quiet -e 'lib/[dev]'
```

- [ ] **Step 2: Write the failing test (with mocked API)**

Create `chart-review-platform/lib/tests/test_generate_corpus_api.py`:

```python
"""Tests for the API-generated code path of generate_corpus.py."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import importlib.util
import pytest

ROOT = Path(__file__).resolve().parents[2]
GEN_SCRIPT = ROOT / "tools" / "generate_corpus.py"


@pytest.fixture()
def gen_module():
    spec = importlib.util.spec_from_file_location("generate_corpus", GEN_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["generate_corpus"] = mod
    spec.loader.exec_module(mod)
    return mod


def _seed():
    return {
        "id": "patient_test_api_01",
        "category": "negative",
        "difficulty": "easy",
        "hand_crafted": False,
        "age": 60,
        "sex": "M",
        "smoking": "never",
        "region": "Test",
        "presenting_complaint": "routine visit",
        "index_date": "2025-01-15",
        "notes": [{"type": "pcp_visit", "date": "2025-01-15"}],
        "target_leaf_answers": {
            "pathology_report_present": "no",
            "pathology_lung_primary": "not_applicable",
            "cytology_supports_lung_primary": "no",
            "imaging_lung_lesion": "no",
            "oncologist_lung_cancer_diagnosis_in_note": "no",
            "icd_lung_cancer_present": "no",
        },
    }


def test_process_api_generated_writes_files(gen_module, tmp_path):
    fake_response = MagicMock()
    fake_response.content = [MagicMock(text="PCP VISIT\nProvider: TEST\nClear lungs.\n")]
    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_response

    with patch.object(gen_module, "_make_anthropic_client", return_value=fake_client):
        gen_module.process_api_generated(tmp_path, _seed(), model_id="claude-sonnet-4-6")

    pat = tmp_path / "patients" / "patient_test_api_01"
    assert (pat / "meta.json").is_file()
    assert (pat / "ground_truth.json").is_file()
    assert (pat / "notes" / "2025-01-15__pcp_visit.txt").is_file()
    note_text = (pat / "notes" / "2025-01-15__pcp_visit.txt").read_text()
    assert "TEST" in note_text
    # Required OMOP files exist (even if empty)
    for table in ("conditions", "procedures", "measurements", "drugs", "observations", "encounters"):
        assert (pat / "omop" / f"{table}.json").is_file()


def test_process_api_generated_idempotent_skips_existing(gen_module, tmp_path):
    fake_client = MagicMock()
    pat = tmp_path / "patients" / "patient_test_api_01"
    pat.mkdir(parents=True)
    (pat / "meta.json").write_text("{}")

    with patch.object(gen_module, "_make_anthropic_client", return_value=fake_client):
        gen_module.process_api_generated(tmp_path, _seed(), model_id="claude-sonnet-4-6")

    fake_client.messages.create.assert_not_called()


def test_ground_truth_consistency_after_api_path(gen_module, tmp_path):
    """Generated ground_truth.json must run cleanly through evaluate_all and
    yield the lung_cancer_status implied by the seed's category."""
    fake_response = MagicMock()
    fake_response.content = [MagicMock(text="dummy note")]
    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_response

    with patch.object(gen_module, "_make_anthropic_client", return_value=fake_client):
        gen_module.process_api_generated(tmp_path, _seed(), model_id="claude-sonnet-4-6")

    gt = json.loads((tmp_path / "patients" / "patient_test_api_01" / "ground_truth.json").read_text())
    assert gt["lung_cancer_status"] == "absent"
```

- [ ] **Step 3: Run test to verify it fails**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_generate_corpus_api.py -v
```

Expected: FAIL — `process_api_generated` does not exist.

- [ ] **Step 4: Add the API-generated path to `tools/generate_corpus.py`**

Modify `tools/generate_corpus.py` — add these helpers and the `process_api_generated` function. Place after `process_hand_crafted` and before `write_index`:

```python
def _make_anthropic_client():
    """Lazy import + construct the Anthropic client.

    Separated for testability — tests patch this to return a mock.
    """
    import anthropic  # type: ignore
    return anthropic.Anthropic()


_NOTE_PROMPT_TEMPLATE = """\
You are generating a single synthetic clinical note for a chart-review benchmark corpus.

Patient context:
- ID: {patient_id}
- Category: {category}
- Demographics: {age}{sex}, {region}
- Smoking: {smoking}
- Presenting complaint: {presenting_complaint}
- Index date: {index_date}

Note to generate:
- Type: {note_type}
- Date: {note_date}

Target ground-truth leaf answers (do NOT state these explicitly in the note;
they are the conclusions a chart reviewer should arrive at after reading the
chart):

{target_answers}

Write a clinically realistic note ≤ 2000 characters. Use plausible clinical
language (HPI, exam, assessment, plan as appropriate to the note type).
Avoid stating "the answer is X." Sign with a plausible provider name and the
date. Output ONLY the note text — no preamble, no markdown fences.
"""


def _omop_skeleton(seed: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Minimal OMOP rows for an API-generated patient.

    Populates only enough to back the target leaf answers — e.g., a C34
    code if icd_lung_cancer_present='yes'. Real richness comes from the
    notes; OMOP here is a stub that the agent can grep on.
    """
    target = seed["target_leaf_answers"]
    rows: dict[str, list[dict[str, Any]]] = {
        "conditions": [],
        "procedures": [],
        "measurements": [],
        "drugs": [],
        "observations": [
            {
                "row_id": 90001,
                "concept_id": 4275495,
                "concept_name": "Smoking status",
                "value": seed["smoking"],
                "date": seed["index_date"],
            }
        ],
        "encounters": [],
    }
    if target.get("icd_lung_cancer_present") == "yes":
        rows["conditions"].append({
            "row_id": 50001,
            "concept_id": 4115276,
            "concept_name": "Malignant neoplasm of bronchus or lung",
            "icd10cm": "C34.10",
            "status": "active",
            "date": seed["index_date"],
        })
    return rows


def process_api_generated(
    corpus_root: Path,
    seed: dict[str, Any],
    *,
    model_id: str,
) -> None:
    """Generate one patient by calling the Claude API once per note.

    Idempotent at the patient level: if patients/<id>/meta.json already
    exists, returns immediately without API calls.
    """
    pid = seed["id"]
    pat_dir = corpus_root / "patients" / pid
    if (pat_dir / "meta.json").is_file():
        return  # already generated; --regenerate would have removed the dir

    pat_dir.mkdir(parents=True, exist_ok=True)
    (pat_dir / "notes").mkdir(exist_ok=True)
    (pat_dir / "omop").mkdir(exist_ok=True)

    # Generate the notes
    client = _make_anthropic_client()
    for note in seed["notes"]:
        out_path = pat_dir / "notes" / f"{note['date']}__{note['type']}.txt"
        prompt = _NOTE_PROMPT_TEMPLATE.format(
            patient_id=pid,
            category=seed["category"],
            age=seed["age"],
            sex=seed["sex"],
            region=seed["region"],
            smoking=seed["smoking"],
            presenting_complaint=seed["presenting_complaint"],
            index_date=seed["index_date"],
            note_type=note["type"],
            note_date=note["date"],
            target_answers=json.dumps(seed["target_leaf_answers"], indent=2),
        )
        response = client.messages.create(
            model=model_id,
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text
        if len(text) > 3000:
            raise ValueError(f"{pid} {note['type']}: generated note exceeds 3000 chars")
        out_path.write_text(text)

    # meta.json
    meta = {
        "patient_id": pid,
        "category": seed["category"],
        "demographics": {"age": seed["age"], "sex": seed["sex"], "region": seed["region"]},
        "smoking": seed["smoking"],
        "index_date": seed["index_date"],
        "doc_types": [n["type"] for n in seed["notes"]],
        "generated_by": "claude_api",
        "generation_run_id": model_id,
    }
    (pat_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")

    # ground_truth.json
    target = seed["target_leaf_answers"]
    full_leaf = {
        "pathology_report_present": target.get("pathology_report_present", "no"),
        "pathology_lung_primary": target.get("pathology_lung_primary", "not_applicable"),
        "cytology_supports_lung_primary": target.get("cytology_supports_lung_primary", "no"),
        "imaging_lung_lesion": target.get("imaging_lung_lesion", "no"),
        "oncologist_lung_cancer_diagnosis_in_note": target.get("oncologist_lung_cancer_diagnosis_in_note", "no"),
        "icd_lung_cancer_present": target.get("icd_lung_cancer_present", "no"),
    }
    applicability = {}
    if full_leaf["pathology_report_present"] == "yes":
        applicability["cytology_supports_lung_primary"] = "not_applicable"
    else:
        applicability["pathology_lung_primary"] = "not_applicable"
        applicability["cytology_supports_lung_primary"] = "applicable"
    # Compute final phenotype label deterministically from the lung-cancer task derivations
    if full_leaf["pathology_report_present"] == "yes" and full_leaf["pathology_lung_primary"] in ("nsclc", "sclc", "other_lung"):
        status = "confirmed"
    elif full_leaf["imaging_lung_lesion"] == "yes" and full_leaf["oncologist_lung_cancer_diagnosis_in_note"] == "yes":
        status = "probable"
    elif full_leaf["icd_lung_cancer_present"] == "yes":
        status = "probable"
    else:
        status = "absent"
    gt = {
        "patient_id": pid,
        "category": seed["category"],
        "lung_cancer_status": status,
        "leaf_answers": full_leaf,
        "applicability": applicability,
        "expected_contradicting_evidence_fields": [],
        "difficulty": "easy",
        "difficulty_notes": f"API-generated. Seed: {seed.get('headline', seed['presenting_complaint'])}.",
    }
    (pat_dir / "ground_truth.json").write_text(json.dumps(gt, indent=2) + "\n")

    # OMOP skeleton
    omop = _omop_skeleton(seed)
    for table, rows in omop.items():
        (pat_dir / "omop" / f"{table}.json").write_text(json.dumps(rows, indent=2) + "\n")
```

Then update the loop in `main()` to call `process_api_generated` instead of skipping:

```python
    for s in seeds:
        if s.get("hand_crafted"):
            process_hand_crafted(args.corpus_root, s)
        else:
            if args.regenerate and args.regenerate != s["id"]:
                continue
            print(f"[gen] {s['id']}…")
            process_api_generated(args.corpus_root, s, model_id=args.model_id)
```

- [ ] **Step 5: Run tests to verify they pass**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_generate_corpus_api.py -v
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/tools/generate_corpus.py chart-review-platform/lib/pyproject.toml chart-review-platform/lib/tests/test_generate_corpus_api.py
git commit -m "Add API-generated code path to tools/generate_corpus.py

Calls Claude API once per note for hand_crafted: false patients in
patient_seeds.yaml. Generates meta.json, ground_truth.json, and per-
table OMOP skeletons. Idempotent at patient level (skips if meta.json
exists). Anthropic SDK added as a dev dep."
```

---

## Task 8: Run generation, commit the 15 API-generated patients

This task is a one-shot execution. Requires a working `ANTHROPIC_API_KEY`.

- [ ] **Step 1: Verify API key is configured**

```sh
echo "${ANTHROPIC_API_KEY:0:10}…"
```

Expected: a non-empty prefix. If empty, set it via the user's preferred secret-management method before continuing.

- [ ] **Step 2: Run the generation script**

```sh
cd "Studies/Chart Review Agents/chart-review-platform"
.venv/bin/python tools/generate_corpus.py
```

Expected output:
```
[gen] patient_easy_nsclc_01…
[gen] patient_easy_nsclc_02…
… (15 lines)
corpus/index.json regenerated with 20 seeds
```

Wall time: ~5–8 minutes for ~50 sequential API calls. If the script crashes mid-run, re-running picks up where it left off (idempotent).

- [ ] **Step 3: Spot-check three generated patients manually**

```sh
ls "Studies/Chart Review Agents/chart-review-platform/corpus/patients/patient_easy_nsclc_01/notes/"
cat "Studies/Chart Review Agents/chart-review-platform/corpus/patients/patient_easy_nsclc_01/notes/2024-11-26__surgical_pathology.txt"
```

Verify:
- Note has plausible clinical structure (header, HPI, assessment, plan).
- Note does NOT explicitly state "the answer is X" or "ground truth: yes."
- Note length is reasonable (≤2000 chars).

Repeat for `patient_easy_sclc_02` and `patient_easy_neg_03`.

- [ ] **Step 4: Run the full corpus library + per-patient tests**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/ -v
```

Expected: all tests pass — including the existing applicability + contracts tests + the corpus tests added in Tasks 1–7.

- [ ] **Step 5: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/corpus
git commit -m "Run corpus generation — 15 API-generated patients

Output of tools/generate_corpus.py against patient_seeds.yaml using
claude-sonnet-4-6. Each patient gets 2–4 generated notes plus
deterministically-computed meta.json / ground_truth.json / OMOP
skeleton. Distribution now matches Phase 1 spec: 5/3/4/3/5."
```

---

## Task 9: Corpus-level structural + distribution tests

**Files:**
- Create: `chart-review-platform/lib/tests/test_corpus_structure.py`

- [ ] **Step 1: Write the structural tests**

Create `chart-review-platform/lib/tests/test_corpus_structure.py`:

```python
"""Whole-corpus structural assertions.

These are guard-rails against future drift — if anything in the corpus
breaks the layout contract, these fail fast.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from chart_review.corpus import iter_patients, load_meta, load_ground_truth
from chart_review.derivation import compute_applicability, evaluate_all

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"
NOTE_NAME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}__[a-z_]+\.txt$")
EXPECTED_COUNTS = {
    "confirmed_nsclc": 5,
    "sclc": 3,
    "probable": 4,
    "icd_only": 3,
    "negative": 5,
}
OMOP_TABLES = ("conditions", "procedures", "measurements", "drugs", "observations", "encounters")


@pytest.fixture(scope="module")
def patients():
    return list(iter_patients(CORPUS))


def test_total_count(patients):
    assert len(patients) == 20, [p["patient_id"] for p in patients]


def test_distribution(patients):
    counts: dict[str, int] = {}
    for p in patients:
        meta = load_meta(CORPUS, p["patient_id"])
        counts[meta["category"]] = counts.get(meta["category"], 0) + 1
    assert counts == EXPECTED_COUNTS


def test_required_files_per_patient(patients):
    for p in patients:
        d = p["path"]
        assert (d / "meta.json").is_file(), p["patient_id"]
        assert (d / "ground_truth.json").is_file(), p["patient_id"]
        assert (d / "notes").is_dir(), p["patient_id"]
        notes = list((d / "notes").glob("*.txt"))
        assert len(notes) >= 2, f"{p['patient_id']} has fewer than 2 notes"
        for n in notes:
            assert NOTE_NAME_RE.match(n.name), f"Bad note filename: {n.name}"
        for tbl in OMOP_TABLES:
            assert (d / "omop" / f"{tbl}.json").is_file(), f"{p['patient_id']} missing {tbl}.json"


def test_meta_validates_against_schema(patients):
    schema = json.loads((CORPUS / "schemas" / "meta.schema.json").read_text())
    v = Draft202012Validator(schema)
    for p in patients:
        meta = load_meta(CORPUS, p["patient_id"])
        v.validate(meta)


def test_ground_truth_validates_against_schema(patients):
    schema = json.loads((CORPUS / "schemas" / "ground_truth.schema.json").read_text())
    v = Draft202012Validator(schema)
    for p in patients:
        gt = load_ground_truth(CORPUS, p["patient_id"])
        v.validate(gt)


def test_internal_consistency(patients):
    """Running evaluate_all over leaf_answers must produce ground-truth status."""
    compiled = json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())
    for p in patients:
        gt = load_ground_truth(CORPUS, p["patient_id"])
        derived = evaluate_all(compiled, gt["leaf_answers"])
        assert derived["lung_cancer_status"] == gt["lung_cancer_status"], (
            f"{p['patient_id']}: derived={derived['lung_cancer_status']}, "
            f"gt={gt['lung_cancer_status']}"
        )


def test_applicability_consistency(patients):
    """compute_applicability over leaf_answers must match ground-truth applicability."""
    compiled = json.loads((ROOT / "ui/public/fixtures/compiled_task.json").read_text())
    for p in patients:
        gt = load_ground_truth(CORPUS, p["patient_id"])
        appl = compute_applicability(compiled, gt["leaf_answers"])
        for fid, expected in gt["applicability"].items():
            assert appl[fid] == expected, (
                f"{p['patient_id']}: {fid} applicability {appl[fid]}, expected {expected}"
            )
```

- [ ] **Step 2: Run the tests**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_corpus_structure.py -v
```

Expected: PASS, 7 tests.

- [ ] **Step 3: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/lib/tests/test_corpus_structure.py
git commit -m "Add corpus-level structural + consistency tests

Fails fast on drift: counts, distribution, required files per
patient, schema conformance, evaluate_all consistency, applicability
consistency."
```

---

## Task 10: `chart-review list-patients` CLI command

**Files:**
- Modify: `chart-review-platform/lib/chart_review/cli.py`
- Modify: `chart-review-platform/lib/tests/test_corpus_library.py` (add CLI test)

- [ ] **Step 1: Write the failing CLI test**

Append to `chart-review-platform/lib/tests/test_corpus_library.py`:

```python


def test_cli_list_patients(tmp_path, monkeypatch, capsys):
    """`chart-review list-patients --corpus-root <root>` lists all patients."""
    # Build a fake corpus with 2 patients
    for pid in ("patient_a", "patient_b"):
        pat = tmp_path / "patients" / pid
        (pat / "notes").mkdir(parents=True)
        (pat / "omop").mkdir()
        (pat / "meta.json").write_text(json.dumps({
            "patient_id": pid,
            "category": "negative",
            "demographics": {"age": 50, "sex": "F"},
            "index_date": "2025-01-01",
            "doc_types": [],
            "generated_by": "hand",
        }))
        (pat / "ground_truth.json").write_text(json.dumps({
            "patient_id": pid,
            "category": "negative",
            "lung_cancer_status": "absent",
            "leaf_answers": {},
            "applicability": {},
            "expected_contradicting_evidence_fields": [],
            "difficulty": "easy",
        }))

    from chart_review.cli import main
    rc = main(["list-patients", "--corpus-root", str(tmp_path)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "patient_a" in out
    assert "patient_b" in out
    assert "negative" in out  # category should appear
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_corpus_library.py::test_cli_list_patients -v
```

Expected: FAIL — `list-patients` is not a registered subcommand.

- [ ] **Step 3: Add the command to `cli.py`**

Modify `chart-review-platform/lib/chart_review/cli.py`:

Add the import near the top:

```python
from .corpus import iter_patients, load_meta
```

Add the `cmd_list_patients` function below the existing command functions (near the other `cmd_*` definitions):

```python
def cmd_list_patients(args) -> int:
    root = Path(args.corpus_root)
    if not (root / "patients").is_dir():
        print(f"No patients/ directory under {root}", file=sys.stderr)
        return 1
    patients = list(iter_patients(root))
    if not patients:
        print(f"No patients found under {root}/patients/")
        return 0
    print(f"{len(patients)} patient(s) under {root}/patients/:")
    print()
    print(f"  {'patient_id':<40} {'category':<18} {'difficulty':<10}")
    print(f"  {'-'*40} {'-'*18} {'-'*10}")
    for p in patients:
        meta = load_meta(root, p["patient_id"])
        try:
            from .corpus import load_ground_truth
            gt = load_ground_truth(root, p["patient_id"])
            difficulty = gt.get("difficulty", "—")
        except FileNotFoundError:
            difficulty = "—"
        print(f"  {p['patient_id']:<40} {meta['category']:<18} {difficulty:<10}")
    return 0
```

Register it inside `main()` next to the other `sub.add_parser` blocks:

```python
    p_lp = sub.add_parser("list-patients", help="List patients in a corpus")
    p_lp.add_argument("--corpus-root", default="corpus", help="Path to the corpus directory")
    p_lp.set_defaults(func=cmd_list_patients)
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
python3 -m pytest tests/test_corpus_library.py::test_cli_list_patients -v
```

Expected: PASS.

- [ ] **Step 5: Smoke-test against the real corpus**

```sh
cd "Studies/Chart Review Agents/chart-review-platform"
.venv/bin/chart-review list-patients --corpus-root corpus
```

Expected output: a 20-row table with patient_id, category, and difficulty.

- [ ] **Step 6: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/lib/chart_review/cli.py chart-review-platform/lib/tests/test_corpus_library.py
git commit -m "Add 'chart-review list-patients' CLI command

Lists all patients in a corpus with category + difficulty. Reads via
the chart_review.corpus helpers; --corpus-root flag points at any
corpus directory."
```

---

## Task 11: UI case-list integration + demo.sh corpus mount

**Files:**
- Modify: `chart-review-platform/ui/src/caseList.jsx`
- Modify: `chart-review-platform/demo.sh`
- Modify: `chart-review-platform/ui/src/store.jsx` (add corpus index loading)

- [ ] **Step 1: Read the current caseList.jsx**

Run `cat chart-review-platform/ui/src/caseList.jsx | head -100` to understand the current structure. Note where the case-list component fetches its case data.

- [ ] **Step 2: Add corpus index loading to the store**

Modify `chart-review-platform/ui/src/store.jsx` — add a state field `corpusIndex` and an action `loadCorpusIndex` that fetches `/corpus/index.json` and stores `state.corpusIndex.patients`. Find the existing fetch for `compiled_task.json` and add a parallel fetch for `/corpus/index.json` that gracefully ignores 404 (so the UI still works on the legacy fixture path).

Concrete additions to the store (find the existing reducer init / initial state):

```jsx
// In the initial state
corpusIndex: null,

// In the reducer
case 'corpus.setIndex':
  return { ...state, corpusIndex: action.value };

// Add an exported helper near where caseList consumes state
async function fetchCorpusIndex(dispatch) {
  try {
    const r = await fetch('/corpus/index.json');
    if (!r.ok) return;
    const idx = await r.json();
    dispatch({ type: 'corpus.setIndex', value: idx });
  } catch (e) {
    // Network error or no corpus/ mount — silently fall back
  }
}

Object.assign(window, { fetchCorpusIndex });
```

- [ ] **Step 3: Update caseList.jsx to render from `state.corpusIndex` when present**

Modify `chart-review-platform/ui/src/caseList.jsx`. Where it currently displays a single hardcoded `patient_demo` row, render rows from `state.corpusIndex.patients` if set; otherwise fall back to the existing single-row display. Trigger the fetch on first mount.

```jsx
function CaseList() {
  const { state, dispatch } = useStore();
  React.useEffect(() => {
    if (!state.corpusIndex) {
      window.fetchCorpusIndex(dispatch);
    }
  }, [state.corpusIndex]);

  const patients = state.corpusIndex?.patients || [
    { patient_id: 'patient_demo', category: 'demo', difficulty: 'easy', headline: 'Bundled demo patient' }
  ];

  return (
    <div className="p-4 space-y-2">
      <h2 className="text-sm font-semibold text-slate-700 mb-3">Cases ({patients.length})</h2>
      {patients.map(p => (
        <a key={p.patient_id} href={`#/case/${p.patient_id}`}
           className="block p-3 rounded-md border border-slate-200 bg-white hover:border-slate-400">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[12px]">{p.patient_id}</span>
            <Pill tone="neutral" size="xs">{p.category}</Pill>
            {p.difficulty === 'hard' && <Pill tone="warn" size="xs">hard</Pill>}
          </div>
          {p.headline && <div className="text-[12.5px] text-slate-600">{p.headline}</div>}
        </a>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Update `demo.sh` to mount `corpus/`**

Modify `chart-review-platform/demo.sh` — the current Step 6 launches `python3 -m http.server` from `$UI`. Change to launch from `$ROOT` (the platform root) so both `ui/` and `corpus/` are served, and update the URL printed.

Find:

```sh
cd "$UI"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
```

Replace with:

```sh
cd "$ROOT"
echo "  serving:   $ROOT  (so both ui/ and corpus/ are reachable)"
echo
echo "   Open in your browser:"
echo
echo "     http://localhost:$PORT/ui/Chart%20Review.html#/case/patient_neg_hard_01"
echo
exec python3 -m http.server "$PORT" --bind 127.0.0.1
```

Also update the earlier echo in the demo script that instructed users to open `Chart%20Review.html` — use the new `/ui/Chart%20Review.html` URL form. The `ui/Chart Review.html` references in code need to load assets relative to a parent path; the existing Babel-loaded scripts use `src="src/store.jsx"` (relative), which works under `/ui/` — verify by checking the network tab.

- [ ] **Step 5: Manually verify the UI**

```sh
cd "Studies/Chart Review Agents/chart-review-platform"
./demo.sh
# In another terminal:
curl -sS http://127.0.0.1:5173/corpus/index.json | head -20
curl -sS http://127.0.0.1:5173/ui/Chart%20Review.html | head -5
```

Both should return 200 with non-zero content.

Then open `http://localhost:5173/ui/Chart%20Review.html#/cases` (or whatever the cases-list anchor is) in a browser. Verify the case list shows 20 entries.

Stop the server (Ctrl-C).

- [ ] **Step 6: Commit**

```sh
cd "Studies/Chart Review Agents"
git add chart-review-platform/ui/src/caseList.jsx chart-review-platform/ui/src/store.jsx chart-review-platform/demo.sh
git commit -m "Wire UI case list to corpus/index.json

Case list fetches /corpus/index.json on mount and renders 20 patients
with category + difficulty pills + headlines. Falls back to the
single-patient demo when no corpus is mounted. demo.sh now serves
from the platform root so both ui/ and corpus/ are reachable."
```

---

## Task 12: End-to-end demo verification + STATE.md update

**Files:**
- Modify: `chart-review-platform/docs/STATE.md` (well, `docs/STATE.md` from the project root)

Wait — STATE.md is at `Studies/Chart Review Agents/docs/STATE.md`, not under `chart-review-platform/`. Verify the path before committing.

- [ ] **Step 1: Run all tests**

```sh
cd "Studies/Chart Review Agents/chart-review-platform/lib"
chflags -R nohidden ../.venv/lib 2>/dev/null
python3 -m pytest -v 2>&1 | tail -30
```

Expected: ALL tests pass.

- [ ] **Step 2: Run the demo end-to-end**

```sh
cd "Studies/Chart Review Agents/chart-review-platform"
./demo.sh
```

Verify in the browser:
- The case list shows 20 patients with category + difficulty pills.
- Click a hard patient (e.g. `patient_confirmed_reread_01`) — verify the contradicting-evidence section still renders correctly (this validates that the corpus integration didn't break the contract additions from `a55011f`).
- Click the existing demo patient (`patient_demo` if still available, otherwise click `patient_easy_nsclc_01`) — verify N/A pills + agent draft card still render.

Stop the server.

- [ ] **Step 3: Update `docs/STATE.md`**

Modify the relevant section of `Studies/Chart Review Agents/docs/STATE.md`:

Change the recommended-next-actions list — strike Task 2:

```markdown
1. ~~Contract additions (`is_applicable_when` + `contradicting_evidence`).~~ **Done in `a55011f`.**
2. ~~Generate 20-patient synthetic corpus with metadata.json ground truth.~~ **Done in `<commit-sha>`.**
3. **Build async batch runner CLI** (`chart-review batch ...`).
4. **Build one real reference skill** using the Claude API (suggest `extract-lab-value`).
5. **Write the concepts cheat-sheet** (2 pages) for engineer onboarding.
6. **Update the design spec** to v0.2 reflecting the new fields + corpus.
```

Also add a new "Corpus" subsection to the inventory:

```markdown
### Corpus

| Path | Purpose |
|---|---|
| `chart-review-platform/corpus/` | 20-patient synthetic corpus (5 hand-crafted + 15 API-generated). |
| `chart-review-platform/tools/patient_seeds.yaml` | Source-of-truth list of all 20 patients. |
| `chart-review-platform/tools/generate_corpus.py` | Idempotent generator script. |
| `chart-review-platform/lib/chart_review/corpus.py` | Filesystem-as-API helpers (read_note, grep_notes, omop_query). |
```

- [ ] **Step 4: Commit STATE.md and finalize**

```sh
cd "Studies/Chart Review Agents"
git add docs/STATE.md
git commit -m "Update STATE.md to reflect Phase 1 Task 2 completion

Marks the synthetic corpus task as done and adds the corpus inventory
to the artifact list."
```

- [ ] **Step 5: Verify final commit history**

```sh
cd "Studies/Chart Review Agents"
git log --oneline -15
```

Expected: a clean sequence of commits from Task 1 (corpus skeleton) through Task 12 (STATE.md update), each described.

---

## Self-Review

**Spec coverage:**
- Goal (3 purposes: functional fixture, agent benchmark, calibration baseline) — covered by Tasks 3–8 producing 20 patients with ground truth + difficulty grading.
- Demonstrate `is_applicable_when` — Task 4c (`patient_probable_cytology_01`).
- Demonstrate `contradicting_evidence` — Task 4b (`patient_confirmed_reread_01`).
- Layout — Task 1 (skeleton + schemas) + Tasks 3, 4a–4d, 8 (populate the tree).
- Patient distribution table (5/3/4/3/5) — Task 9 (`test_distribution`) enforces it.
- Hand-crafted scenarios (5 listed in spec) — exactly Tasks 3, 4a–4d.
- API-generated patients (15) — Tasks 5 (seeds), 7 (script), 8 (run + commit).
- Ground-truth schema (per spec example) — Task 1 schema + Task 4b's hand-crafted ground_truth.json show all fields populated.
- Generation pipeline (`tools/generate_corpus.py`, `patient_seeds.yaml`, idempotent, reproducibility via index.json) — Tasks 5, 6, 7.
- Adapter integration (`chart_review.corpus`, CLI `list-patients`, UI case list, `demo.sh`) — Tasks 2, 10, 11.
- Validation (structural / distribution / consistency / hand-crafted assertions / schema) — Tasks 3 (per-patient), 4a–4d (per-patient), 9 (corpus-wide).
- Out-of-scope items confirmed not included (multi-reviewer, real EHR, scanned PDFs, vital signs out of `observations`).
- Open questions (concepts.json curated, single-shot Claude API, storage budget alarm at 3000 chars) — addressed in Task 1 (curated icd10cm.json), Task 7 (single `client.messages.create`), Task 7 (the `> 3000` raise).

**Placeholder scan:** No TBDs / TODOs in any task; every step has either runnable code or exact commands. Every code change shows the actual change.

**Type consistency:** `process_hand_crafted`, `process_api_generated`, `load_seeds`, `_make_anthropic_client`, `_omop_skeleton`, `write_index` all consistent across Tasks 6/7. `iter_patients`, `load_meta`, `load_ground_truth`, `read_note`, `grep_notes`, `omop_query` consistent across Tasks 2/9/10. `corpus_root` is the consistent argument name throughout.

**Scope:** This plan is one Phase 1 sub-task (Task 2 of the staged plan). The next sub-tasks (batch runner, reference skill, concepts cheat-sheet, spec v0.2) are out of scope for this plan and listed in STATE.md's "Recommended next actions."
