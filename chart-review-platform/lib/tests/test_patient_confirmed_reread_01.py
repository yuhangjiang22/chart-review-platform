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
    compiled = json.loads((ROOT / "lib/tests/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
