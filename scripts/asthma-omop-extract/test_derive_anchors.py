"""Unit tests for derive_anchors.py.

Run: python3 -m pytest scripts/asthma-omop-extract/test_derive_anchors.py -q

Originally written for the Task 6 code review (adjudicated item 10); extended
2026-08-27 for the four document-alignment fixes — observation window,
one-event-per-visit-day, merged exacerbation definition, and the obligation
grace deadline. See the module docstring in derive_anchors.py for the source
of each decision.
"""
from datetime import date

from derive_anchors import (
    parse_date,
    window_for,
    _clean_rows,
    asthma_encounter_anchors,
    ocs_burst_anchors,
    exacerbation_anchors,
    obligation_point_anchors,
)

# Index 2025-12-31 -> window is (2024-12-31, 2025-12-31]. Every fixture date
# below sits in 2025 unless a test is specifically about the boundary.
INDEX = date(2025, 12, 31)
WIN = window_for(INDEX)


def _ocs(row_id, fill_date):
    return {"drug_class": "OCS", "row_id": row_id, "fills": [{"fill_date": fill_date}]}


def _enc(row_id, start_date, asthma_related=True, typ="Outpatient Visit"):
    return {"row_id": row_id, "start_date": start_date, "type": typ, "asthma_related": asthma_related}


def _ed(row_id, start_date, asthma_related=True):
    return {"row_id": row_id, "start_date": start_date, "type": "Emergency Room Visit",
            "is_ed": True, "asthma_related": asthma_related}


def _inpatient(row_id, start_date, asthma_related=True):
    return {"row_id": row_id, "start_date": start_date, "type": "Inpatient Visit",
            "asthma_related": asthma_related}


# --- (a) 14-day boundary: day-14 merges, day-15 splits -----------------

def test_burst_separation_day_14_merges():
    drugs = [_ocs("d1", "2025-01-01"), _ocs("d2", "2025-01-15")]  # +14 days
    bursts = ocs_burst_anchors(drugs, WIN)
    assert len(bursts) == 1
    assert bursts[0]["date"] == "2025-01-01"


def test_burst_separation_day_15_splits():
    drugs = [_ocs("d1", "2025-01-01"), _ocs("d2", "2025-01-16")]  # +15 days
    bursts = ocs_burst_anchors(drugs, WIN)
    assert len(bursts) == 2
    assert [b["date"] for b in bursts] == ["2025-01-01", "2025-01-16"]


# --- (b) same-date fills across two rows -> one burst ------------------

def test_same_date_fills_across_two_rows_collapse_to_one_burst():
    drugs = [_ocs("d1", "2025-02-01"), _ocs("d2", "2025-02-01")]
    bursts = ocs_burst_anchors(drugs, WIN)
    assert len(bursts) == 1
    # explicit tiebreak (date, str(row_id)) -> "d1" sorts before "d2"
    assert bursts[0]["ref"] == "drugs:d1"


# --- (c) null/None dates skipped and counted ---------------------------

def test_null_start_date_encounter_skipped_and_counted():
    stats = {}
    rows = asthma_encounter_anchors([_enc("e1", None), _enc("e2", "2025-03-01")], WIN, stats)
    assert [r["date"] for r in rows] == ["2025-03-01"]
    assert stats["skipped"] == 1


def test_none_fill_date_ocs_skipped_and_counted():
    stats = {}
    drugs = [{"drug_class": "OCS", "row_id": "d1",
              "fills": [{"fill_date": None}, {"fill_date": "2025-04-01"}]}]
    bursts = ocs_burst_anchors(drugs, WIN, stats)
    assert [b["date"] for b in bursts] == ["2025-04-01"]
    assert stats["skipped"] == 1


# --- (d) defensive row cleaning ----------------------------------------

def test_clean_rows_filters_non_dict_without_crash():
    assert _clean_rows([{"a": 1}, "junk", None, {"b": 2}], "encounters", "p1") == [{"a": 1}, {"b": 2}]


def test_clean_rows_non_list_input_returns_empty():
    assert _clean_rows({"not": "a list"}, "drugs", "p1") == []


def test_ocs_burst_anchors_skips_non_dict_fill_without_crash():
    drugs = [{"drug_class": "OCS", "row_id": "d1", "fills": ["junk", {"fill_date": "2025-05-01"}]}]
    assert [b["date"] for b in ocs_burst_anchors(drugs, WIN)] == ["2025-05-01"]


# --- (e) date normalization --------------------------------------------

def test_parse_date_normalizes_timestamp():
    assert parse_date("2025-06-01T14:30:00") == date(2025, 6, 1)


def test_encounter_anchor_date_normalized_from_timestamp():
    rows = asthma_encounter_anchors([_enc("e1", "2025-06-01T14:30:00")], WIN)
    assert rows[0]["date"] == "2025-06-01"


def test_ocs_burst_date_normalized_from_timestamp():
    bursts = ocs_burst_anchors([_ocs("d1", "2025-06-01T09:00:00")], WIN)
    assert bursts[0]["date"] == "2025-06-01"


def test_parse_date_invalid_returns_none():
    assert parse_date("not-a-date") is None
    assert parse_date(None) is None


# --- (f) encounter qualifying rules ------------------------------------

def test_ed_kind_inferred_from_type_when_is_ed_absent():
    rows = asthma_encounter_anchors(
        [{"row_id": "e1", "start_date": "2025-07-01", "type": "Emergency Room Visit",
          "asthma_related": True}], WIN)
    assert rows[0]["meta"]["kind"] == "ed"


def test_inpatient_excluded_even_if_asthma_related():
    assert asthma_encounter_anchors([_inpatient("e1", "2025-07-02")], WIN) == []


def test_non_asthma_encounter_excluded():
    assert asthma_encounter_anchors([_enc("e1", "2025-07-03", asthma_related=False)], WIN) == []


# --- (g) observation window (decision 1) -------------------------------

def test_encounter_before_window_excluded_and_counted():
    stats = {}
    rows = asthma_encounter_anchors(
        [_enc("e1", "2020-01-01"), _enc("e2", "2025-07-04")], WIN, stats)
    assert [r["date"] for r in rows] == ["2025-07-04"]
    assert stats["out_of_window"] == 1


def test_window_boundary_is_exclusive_at_lo_inclusive_at_index():
    # window is (2024-12-31, 2025-12-31]
    rows = asthma_encounter_anchors(
        [_enc("e1", "2024-12-31"), _enc("e2", "2025-01-01"), _enc("e3", "2025-12-31")], WIN)
    assert [r["date"] for r in rows] == ["2025-01-01", "2025-12-31"]


def test_burst_outside_window_excluded():
    bursts = ocs_burst_anchors([_ocs("d1", "2019-01-01")], WIN)
    assert bursts == []


def test_window_for_none_index_returns_none():
    assert window_for(None) is None


# --- (h) one anchor per visit-day (decision 2) -------------------------

def test_same_day_encounters_collapse_to_one_anchor():
    rows = asthma_encounter_anchors(
        [_enc("e3", "2025-08-01"), _enc("e1", "2025-08-01"), _enc("e2", "2025-08-01")], WIN)
    assert len(rows) == 1
    assert rows[0]["meta"]["n_encounters"] == 3
    # deterministic representative: lexicographically first row_id
    assert rows[0]["ref"] == "encounters:e1"


def test_distinct_days_stay_distinct():
    rows = asthma_encounter_anchors(
        [_enc("e1", "2025-08-01"), _enc("e2", "2025-08-02")], WIN)
    assert [r["date"] for r in rows] == ["2025-08-01", "2025-08-02"]


def test_day_with_ed_and_outpatient_is_outpatient():
    rows = asthma_encounter_anchors(
        [_ed("e1", "2025-08-03"), _enc("e2", "2025-08-03")], WIN)
    assert len(rows) == 1
    assert rows[0]["meta"]["kind"] == "outpatient"


def test_day_with_only_ed_is_ed():
    rows = asthma_encounter_anchors([_ed("e1", "2025-08-04")], WIN)
    assert rows[0]["meta"]["kind"] == "ed"


# --- (i) merged exacerbation definition (decision 3) -------------------

def test_exacerbation_includes_asthma_ed_visit_with_no_ocs():
    exac = exacerbation_anchors([], [_ed("e1", "2025-09-01")], WIN)
    assert [e["date"] for e in exac] == ["2025-09-01"]


def test_exacerbation_includes_asthma_inpatient():
    exac = exacerbation_anchors([], [_inpatient("e1", "2025-09-02")], WIN)
    assert [e["date"] for e in exac] == ["2025-09-02"]


def test_exacerbation_excludes_non_asthma_ed():
    assert exacerbation_anchors([], [_ed("e1", "2025-09-03", asthma_related=False)], WIN) == []


def test_exacerbation_excludes_routine_outpatient_visit():
    """An ordinary asthma clinic visit is a judgment point, not an exacerbation."""
    assert exacerbation_anchors([], [_enc("e1", "2025-09-04")], WIN) == []


def test_ed_visit_and_same_day_ocs_fill_are_one_exacerbation():
    exac = exacerbation_anchors([_ocs("d1", "2025-09-05")], [_ed("e1", "2025-09-05")], WIN)
    assert len(exac) == 1


def test_ocs_bursts_stay_ocs_only_when_an_ed_visit_exists():
    """The follow-up rule anchors on ocs_bursts; folding the ED visit in there
    would ask the follow-up question twice for the same day (it already has an
    asthma_encounters anchor)."""
    bursts = ocs_burst_anchors([], WIN)
    assert bursts == []
    assert len(exacerbation_anchors([], [_ed("e1", "2025-09-06")], WIN)) == 1


# --- (j) obligation point (decisions 3 + 4) ----------------------------

def _exac_on(*iso_dates):
    return [{"date": d, "ref": f"drugs:x{i}", "_in_window": True}
            for i, d in enumerate(iso_dates)]


def test_obligation_is_second_exacerbation_within_a_year():
    exac = _exac_on("2025-01-10", "2025-06-10")
    pts = obligation_point_anchors(exac, [], WIN)
    assert [p["date"] for p in pts] == ["2025-06-10"]


def test_obligation_empty_with_a_single_exacerbation():
    assert obligation_point_anchors(_exac_on("2025-01-10"), [], WIN) == []


def test_obligation_not_triggered_when_pair_more_than_a_year_apart():
    exac = [{"date": "2023-01-01", "ref": "drugs:a", "_in_window": False},
            {"date": "2025-06-10", "ref": "drugs:b", "_in_window": True}]
    assert obligation_point_anchors(exac, [], WIN) == []


def test_pre_window_first_exacerbation_still_establishes_the_pair():
    """First course predates the window, second falls inside it and within a
    rolling year — the patient is obliged, and the in-window date is emitted."""
    exac = [{"date": "2024-12-01", "ref": "drugs:a", "_in_window": False},
            {"date": "2025-03-01", "ref": "drugs:b", "_in_window": True}]
    pts = obligation_point_anchors(exac, [], WIN)
    assert [p["date"] for p in pts] == ["2025-03-01"]


def test_obligation_re_established_inside_the_window_after_an_older_one():
    """A patient first obliged years ago, who exacerbates twice again inside
    the window, is still owed a controller DURING the window under audit.

    Regression: scanning all history for the first qualifying pair and only
    then testing it for window membership dropped these patients entirely —
    on the real 33-patient set it cut the obliged group from 25 to 5.
    """
    exac = [{"date": "2020-01-01", "ref": "drugs:a", "_in_window": False},
            {"date": "2020-05-01", "ref": "drugs:b", "_in_window": False},
            {"date": "2025-03-01", "ref": "drugs:c", "_in_window": True},
            {"date": "2025-07-01", "ref": "drugs:d", "_in_window": True}]
    pts = obligation_point_anchors(exac, [], WIN)
    assert [p["date"] for p in pts] == ["2025-07-01"]


def test_obligation_point_outside_window_not_emitted():
    exac = [{"date": "2020-01-01", "ref": "drugs:a", "_in_window": False},
            {"date": "2020-06-01", "ref": "drugs:b", "_in_window": False}]
    assert obligation_point_anchors(exac, [], WIN) == []


def test_only_the_first_obligation_is_emitted():
    exac = _exac_on("2025-01-10", "2025-02-10", "2025-03-10")
    pts = obligation_point_anchors(exac, [], WIN)
    assert len(pts) == 1
    assert pts[0]["date"] == "2025-02-10"


def test_deadline_is_the_next_asthma_visit_after_the_obligation():
    exac = _exac_on("2025-01-10", "2025-06-10")
    encs = asthma_encounter_anchors(
        [_enc("e1", "2025-06-10"), _enc("e2", "2025-08-20"), _enc("e3", "2025-11-01")], WIN)
    pts = obligation_point_anchors(exac, encs, WIN)
    assert pts[0]["meta"]["deadline"] == "2025-08-20"
    assert pts[0]["meta"]["deadline_censored"] is False


def test_visit_on_the_obligation_date_is_not_the_deadline():
    """The obligation-day visit is an opportunity to start the controller, so
    it must not also be the deadline — that would give a zero-length window."""
    exac = _exac_on("2025-01-10", "2025-06-10")
    encs = asthma_encounter_anchors([_enc("e1", "2025-06-10")], WIN)
    pts = obligation_point_anchors(exac, encs, WIN)
    assert pts[0]["meta"]["deadline"] == INDEX.isoformat()
    assert pts[0]["meta"]["deadline_censored"] is True


def test_deadline_censored_at_index_when_no_later_visit():
    exac = _exac_on("2025-01-10", "2025-06-10")
    pts = obligation_point_anchors(exac, [], WIN)
    assert pts[0]["meta"]["deadline"] == INDEX.isoformat()
    assert pts[0]["meta"]["deadline_censored"] is True
