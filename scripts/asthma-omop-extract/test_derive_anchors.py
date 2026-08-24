"""Unit tests for derive_anchors.py (Task 6 code review, adjudicated item 10).

Run: python3 -m pytest scripts/asthma-omop-extract/test_derive_anchors.py -q
"""
from derive_anchors import (
    parse_date,
    _clean_rows,
    asthma_encounter_anchors,
    ocs_burst_anchors,
    obligation_point_anchors,
)


def _ocs(row_id, fill_date):
    return {"drug_class": "OCS", "row_id": row_id, "fills": [{"fill_date": fill_date}]}


def _enc(row_id, start_date, asthma_related=True, typ="Outpatient Visit"):
    return {"row_id": row_id, "start_date": start_date, "type": typ, "asthma_related": asthma_related}


# --- (a) 14-day boundary: day-14 merges, day-15 splits -----------------

def test_burst_separation_day_14_merges():
    drugs = [_ocs("d1", "2025-01-01"), _ocs("d2", "2025-01-15")]  # +14 days
    bursts = ocs_burst_anchors(drugs)
    assert len(bursts) == 1
    assert bursts[0]["date"] == "2025-01-01"


def test_burst_separation_day_15_splits():
    drugs = [_ocs("d1", "2025-01-01"), _ocs("d2", "2025-01-16")]  # +15 days
    bursts = ocs_burst_anchors(drugs)
    assert len(bursts) == 2
    assert [b["date"] for b in bursts] == ["2025-01-01", "2025-01-16"]


# --- (b) same-date fills across two rows -> one burst ------------------

def test_same_date_fills_across_two_rows_collapse_to_one_burst():
    drugs = [_ocs("d1", "2025-02-01"), _ocs("d2", "2025-02-01")]
    bursts = ocs_burst_anchors(drugs)
    assert len(bursts) == 1
    # explicit tiebreak (date, str(row_id)) -> "d1" sorts before "d2"
    assert bursts[0]["ref"] == "drugs:d1"


# --- (c) null/None start_date rows skipped and counted ------------------

def test_null_start_date_encounter_skipped_and_counted():
    encounters = [
        _enc("e1", "2025-01-01"),
        _enc("e2", None),
        {"row_id": "e3", "start_date": None, "type": "Outpatient Visit", "asthma_related": True},
    ]
    stats = {}
    out = asthma_encounter_anchors(encounters, stats)
    assert [a["ref"] for a in out] == ["encounters:e1"]
    assert stats["skipped"] == 2


def test_none_fill_date_ocs_skipped_and_counted():
    drugs = [
        {"drug_class": "OCS", "row_id": "d1", "fills": [{"fill_date": "2025-01-01"}, {"fill_date": None}]},
    ]
    stats = {}
    bursts = ocs_burst_anchors(drugs, stats)
    assert len(bursts) == 1
    assert stats["skipped"] == 1


# --- (d) non-dict row filtered without crash ----------------------------

def test_clean_rows_filters_non_dict_without_crash():
    rows = [{"row_id": 1}, "not-a-row", 42, None, {"row_id": 2}]
    out = _clean_rows(rows, "encounters", "patient_fake_test")
    assert out == [{"row_id": 1}, {"row_id": 2}]


def test_clean_rows_non_list_input_returns_empty():
    out = _clean_rows({"oops": "not a list"}, "encounters", "patient_fake_test")
    assert out == []


def test_ocs_burst_anchors_skips_non_dict_fill_without_crash():
    drugs = [{"drug_class": "OCS", "row_id": "d1", "fills": [{"fill_date": "2025-01-01"}, "garbage", None]}]
    bursts = ocs_burst_anchors(drugs)
    assert len(bursts) == 1


# --- (e) obligation = 2nd burst only ------------------------------------

def test_obligation_is_second_burst_only():
    bursts = [{"date": "2025-01-01", "ref": "drugs:d1"}, {"date": "2025-02-01", "ref": "drugs:d2"}]
    assert obligation_point_anchors(bursts) == [{"date": "2025-02-01", "ref": "drugs:d2"}]


def test_obligation_empty_with_zero_or_one_burst():
    assert obligation_point_anchors([]) == []
    assert obligation_point_anchors([{"date": "2025-01-01", "ref": "drugs:d1"}]) == []


def test_obligation_only_first_two_of_three_bursts():
    bursts = [
        {"date": "2025-01-01", "ref": "drugs:d1"},
        {"date": "2025-02-01", "ref": "drugs:d2"},
        {"date": "2025-03-01", "ref": "drugs:d3"},
    ]
    assert obligation_point_anchors(bursts) == [{"date": "2025-02-01", "ref": "drugs:d2"}]


# --- (f) date normalization ----------------------------------------------

def test_parse_date_normalizes_timestamp():
    d = parse_date("2025-01-01T10:30:00Z")
    assert d is not None
    assert d.isoformat() == "2025-01-01"


def test_encounter_anchor_date_normalized_from_timestamp():
    encounters = [_enc("e1", "2025-01-01T10:30:00Z")]
    out = asthma_encounter_anchors(encounters)
    assert out[0]["date"] == "2025-01-01"


def test_ocs_burst_date_normalized_from_timestamp():
    drugs = [_ocs("d1", "2025-01-01T10:30:00Z")]
    bursts = ocs_burst_anchors(drugs)
    assert bursts[0]["date"] == "2025-01-01"


def test_parse_date_invalid_returns_none():
    assert parse_date("not-a-date") is None
    assert parse_date(None) is None


# --- meta.kind + is_ed inference sanity (existing behavior, not in the
# adjudicated list but cheap to pin down given we touched this code path) --

def test_ed_kind_inferred_from_type_when_is_ed_absent():
    encounters = [_enc("e1", "2025-01-01", typ="Emergency")]
    out = asthma_encounter_anchors(encounters)
    assert out[0]["meta"]["kind"] == "ed"


def test_inpatient_excluded_even_if_asthma_related():
    encounters = [_enc("e1", "2025-01-01", typ="Inpatient Visit")]
    out = asthma_encounter_anchors(encounters)
    assert out == []
