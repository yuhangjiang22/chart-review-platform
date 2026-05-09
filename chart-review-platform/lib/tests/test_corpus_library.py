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


def test_omop_query_in_predicate(fake_corpus: Path):
    rows = omop_query(
        fake_corpus, "patient_001", "conditions",
        {"icd10cm_in": ["C34.10", "Z85.118"]},
    )
    assert len(rows) == 1
    assert rows[0]["icd10cm"] == "C34.10"


def test_iter_patients_returns_empty_iterator_when_missing(tmp_path: Path):
    """When the corpus has no patients/ subdir, iter_patients yields nothing."""
    assert list(iter_patients(tmp_path)) == []


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
