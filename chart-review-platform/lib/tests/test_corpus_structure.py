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
    compiled = json.loads((ROOT / "lib/tests/fixtures/compiled_task.json").read_text())
    for p in patients:
        gt = load_ground_truth(CORPUS, p["patient_id"])
        derived = evaluate_all(compiled, gt["leaf_answers"])
        assert derived["lung_cancer_status"] == gt["lung_cancer_status"], (
            f"{p['patient_id']}: derived={derived['lung_cancer_status']}, "
            f"gt={gt['lung_cancer_status']}"
        )


def test_applicability_consistency(patients):
    """compute_applicability over leaf_answers must match ground-truth applicability."""
    compiled = json.loads((ROOT / "lib/tests/fixtures/compiled_task.json").read_text())
    for p in patients:
        gt = load_ground_truth(CORPUS, p["patient_id"])
        appl = compute_applicability(compiled, gt["leaf_answers"])
        for fid, expected in gt["applicability"].items():
            assert appl[fid] == expected, (
                f"{p['patient_id']}: {fid} applicability {appl[fid]}, expected {expected}"
            )
