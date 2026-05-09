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
    compiled = json.loads((ROOT / "lib/tests/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
