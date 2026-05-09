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
    compiled = json.loads((ROOT / "lib/tests/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
