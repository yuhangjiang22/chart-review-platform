"""Tests for etl.roll_up_drugs — the 12-month drug fields the SABA-overuse rule
and the controller-adherence proxy read.

Two silent downward biases lived here:

- `saba_canisters_12mo` counts FILLS while being named canisters, and the rubric
  cites "≥3 canisters/year per HEDIS AMR" straight off it. quantity is null on all
  6,653 fills of every class in this drop, so the fill count is the only thing
  available — but the number now says which basis produced it, and a drop that DOES
  carry quantity surfaces it as data instead of silently redefining the count.
- PDC summed `days_supply or 0`, so a null read as zero coverage. A drug with nine
  documented fills and one null one reported less coverage than it had.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from etl import roll_up_drugs

LO, IDX = "2024-06-01", "2025-06-01"


def row(concept_id, name, cls, ctrl, fill_date, days_supply=None, quantity=None, row_id=1):
    return {"row_id": row_id, "concept_id": concept_id, "concept_name": name,
            "rxnorm": "12345", "drug_class": cls, "is_controller": ctrl,
            "fill_date": fill_date, "days_supply": days_supply, "quantity": quantity}


def saba(n_fills, **kw):
    return [row(1, "albuterol", "SABA", False, f"2024-{7 + i:02d}-01", **kw) for i in range(n_fills)]


def test_saba_counts_in_window_fills_and_says_so():
    out = roll_up_drugs(saba(3), LO, IDX)
    assert out[0]["saba_canisters_12mo"] == 3
    assert out[0]["saba_canisters_basis"] == "fills"
    assert "saba_quantity_12mo" not in out[0]      # no quantity in the source


def test_window_is_exclusive_at_the_low_end():
    # A fill exactly 12 months before the index date is OUT; the day after is IN.
    rows = [row(1, "albuterol", "SABA", False, LO), row(1, "albuterol", "SABA", False, "2024-06-02")]
    assert roll_up_drugs(rows, LO, IDX)[0]["saba_canisters_12mo"] == 1


def test_a_fill_after_the_index_date_is_out():
    rows = saba(1) + [row(1, "albuterol", "SABA", False, "2025-07-01")]
    assert roll_up_drugs(rows, LO, IDX)[0]["saba_canisters_12mo"] == 1


def test_quantity_is_reported_but_does_NOT_become_the_count():
    # The whole point: a drop that dispenses 2 units per fill must not silently
    # double the number the >= 3 threshold is applied to, because "2" could be
    # units, grams, or actuations depending on the site.
    out = roll_up_drugs(saba(2, quantity=2), LO, IDX)
    assert out[0]["saba_canisters_12mo"] == 2       # fills, unchanged
    assert out[0]["saba_canisters_basis"] == "fills"
    assert out[0]["saba_quantity_12mo"] == 4.0      # surfaced for a human to judge


def test_saba_total_is_summed_across_ingredients():
    rows = saba(2) + [row(2, "levalbuterol", "SABA", False, "2025-01-01", row_id=2)]
    out = roll_up_drugs(rows, LO, IDX)
    assert {d["saba_canisters_12mo"] for d in out} == {3}   # both rows carry the total


def test_pdc_ignores_nulls_instead_of_counting_them_as_zero_coverage():
    rows = [row(3, "fluticasone", "ICS", True, "2024-07-01", days_supply=90),
            row(3, "fluticasone", "ICS", True, "2024-10-01", days_supply=90),
            row(3, "fluticasone", "ICS", True, "2025-01-01", days_supply=None)]
    ics = roll_up_drugs(rows, LO, IDX)[0]
    assert ics["refill_pdc_12mo"] == round(180 / 365.0, 2)
    # and it says the rate rests on 2 of 3 fills
    assert "1 of 3" in ics["refill_pdc_partial"]


def test_a_complete_pdc_carries_no_partial_marker():
    rows = [row(3, "fluticasone", "ICS", True, "2024-07-01", days_supply=180),
            row(3, "fluticasone", "ICS", True, "2025-01-01", days_supply=180)]
    ics = roll_up_drugs(rows, LO, IDX)[0]
    assert ics["refill_pdc_12mo"] == 0.99
    assert "refill_pdc_partial" not in ics


def test_no_days_supply_at_all_means_no_pdc_rather_than_zero():
    rows = [row(3, "fluticasone", "ICS", True, "2024-07-01")]
    ics = roll_up_drugs(rows, LO, IDX)[0]
    assert "refill_pdc_12mo" not in ics            # absent, not 0.0
    assert "refill_pdc_partial" not in ics


def test_pdc_is_controller_only():
    out = roll_up_drugs(saba(1, days_supply=30), LO, IDX)
    assert "refill_pdc_12mo" not in out[0]


def test_fills_are_sorted_and_start_date_is_the_earliest():
    rows = [row(1, "albuterol", "SABA", False, "2025-01-01"),
            row(1, "albuterol", "SABA", False, "2024-07-01")]
    out = roll_up_drugs(rows, LO, IDX)[0]
    assert out["start_date"] == "2024-07-01"
    assert out["n_fills"] == 2
    assert [f["fill_date"] for f in out["fills"]] == ["2024-07-01", "2025-01-01"]
