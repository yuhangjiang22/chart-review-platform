from pathlib import Path

import pytest

from chart_review.codify import codify

FIX = Path(__file__).resolve().parent / "fixtures" / "codify"
LOCKED_TASK = FIX / "locked-task"
REVIEWS = FIX / "reviews"


def _run():
    return codify(package_dir=LOCKED_TASK, reviews_root=REVIEWS, task_id="locked-task")


def test_returns_three_artifact_families():
    bundle = _run()
    assert "keyword_sets" in bundle
    assert "code_sets" in bundle
    assert "note_type_filters" in bundle


def test_keyword_sets_emitted_per_criterion_with_note_evidence():
    bundle = _run()
    # lung_pathology has note evidence in 3 patients → keyword_set emitted.
    assert "kw_lung_pathology" in bundle["keyword_sets"]
    assert "kw_lung_imaging" in bundle["keyword_sets"]


def test_no_keyword_set_for_criterion_without_note_evidence():
    bundle = _run()
    # age_at_index has no evidence rows in any reviewed patient.
    assert "kw_age_at_index" not in bundle["keyword_sets"]
    # lung_status is derived; no direct evidence either.
    assert "kw_lung_status" not in bundle["keyword_sets"]


def test_keyword_terms_ranked_by_patient_count():
    bundle = _run()
    pathology_kw = bundle["keyword_sets"]["kw_lung_pathology"]
    # "biopsy" appears in patient_01 + patient_02 + patient_03 → patient_count = 3.
    biopsy = next(s for s in pathology_kw["term_stats"] if s["term"] == "biopsy")
    assert biopsy["patient_count"] == 3


def test_terms_list_matches_term_stats():
    bundle = _run()
    pathology_kw = bundle["keyword_sets"]["kw_lung_pathology"]
    assert sorted(pathology_kw["terms"]) == sorted(s["term"] for s in pathology_kw["term_stats"])


def test_excludes_agent_only_patient_evidence():
    """patient_05 is oracle_done=false; its AGENT_GUESS_TOKEN must not appear."""
    bundle = _run()
    # No keyword_set should include the sentinel token.
    for kw in bundle["keyword_sets"].values():
        for s in kw["term_stats"]:
            assert "agent_guess_token" not in s["term"].lower()


def test_excludes_evidence_from_unflagged_patients():
    """Evidence rows from agent-only patients are skipped entirely."""
    bundle = _run()
    # patient_05's discharge_summary should not contribute to any note_type_filter.
    for crit_filter in bundle["note_type_filters"]["filters"].values():
        assert "discharge_summary" not in crit_filter.get("high", [])
        assert "discharge_summary" not in crit_filter.get("medium", [])
        assert "discharge_summary" not in crit_filter.get("low", [])


def test_code_set_emitted_for_omop_evidence():
    bundle = _run()
    assert "codes_lung_pathology" in bundle["code_sets"]
    codes = bundle["code_sets"]["codes_lung_pathology"]["codes"]
    cids = {c["concept_id"] for c in codes}
    assert 4115276 in cids


def test_code_set_includes_icd_prefix_hint():
    """3 leaves of C34 (C34.10, C34.11, C34.31) → C34.x prefix hint."""
    bundle = _run()
    cs = bundle["code_sets"]["codes_lung_pathology"]
    assert "prefix_hints" in cs
    prefixes = {p["prefix"] for p in cs["prefix_hints"]}
    assert "C34.x" in prefixes


def test_note_type_filters_assigned_per_criterion():
    bundle = _run()
    f = bundle["note_type_filters"]["filters"]
    # lung_pathology evidence came from 3/4 oracle_done patients → ≥80% threshold? 75% — medium.
    # lung_imaging evidence came from 4/4 oracle_done patients → 100% — high.
    lp = f.get("lung_pathology", {})
    li = f.get("lung_imaging", {})
    assert "pathology" in (lp.get("high", []) + lp.get("medium", []))
    assert "radiology" in (li.get("high", []) + li.get("medium", []))


def test_derived_from_block_set_on_every_artifact():
    bundle = _run()
    for kw in bundle["keyword_sets"].values():
        assert kw["derived_from"]["guideline_manual_version"] == "1.0.0"
        assert kw["derived_from"]["cohort_size"] == 4  # 4 oracle_done patients
        assert "codified_at" in kw["derived_from"]
    for cs in bundle["code_sets"].values():
        assert cs["derived_from"]["cohort_size"] == 4
    assert bundle["note_type_filters"]["derived_from"]["cohort_size"] == 4


def test_refuses_empty_cohort(tmp_path):
    """No oracle_done patients → raise."""
    empty_reviews = tmp_path / "reviews"
    empty_reviews.mkdir()
    with pytest.raises(ValueError, match="no validated patients"):
        codify(package_dir=LOCKED_TASK, reviews_root=empty_reviews, task_id="locked-task")
