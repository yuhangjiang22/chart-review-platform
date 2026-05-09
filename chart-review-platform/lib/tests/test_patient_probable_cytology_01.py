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
    compiled = json.loads((ROOT / "lib/tests/fixtures/compiled_task.json").read_text())
    appl = compute_applicability(compiled, gt["leaf_answers"])
    assert appl["pathology_lung_primary"] == "not_applicable"
    assert appl["cytology_supports_lung_primary"] == "applicable"


def test_internal_consistency():
    gt = load_ground_truth(CORPUS, PID)
    compiled = json.loads((ROOT / "lib/tests/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
