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
    compiled = json.loads((ROOT / "lib/tests/fixtures/compiled_task.json").read_text())
    derived = evaluate_all(compiled, gt["leaf_answers"])
    assert derived["lung_cancer_status"] == gt["lung_cancer_status"]
