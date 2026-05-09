"""Lift A — Python unit tests for arithmetic + builtins in `derivation.evaluate`.

Cross-language parity is covered by `test_contract_eval.py`. This file
exercises Python-side specifics (precedence, error paths, builtin signatures,
type semantics) that the parity corpus only checks at result-equality.
"""

from __future__ import annotations

import pytest

from chart_review.derivation import evaluate


# ---------- arithmetic ----------

def test_addition_subtraction():
    assert evaluate("3 + 4", {}) == 7
    assert evaluate("10 - 3", {}) == 7
    assert evaluate("10 - 3 - 2", {}) == 5  # left-assoc


def test_multiplication_division():
    assert evaluate("6 * 7", {}) == 42
    assert evaluate("12 / 4", {}) == 3
    assert evaluate("24 / 2 / 3", {}) == 4  # left-assoc


def test_precedence_mul_above_add():
    assert evaluate("1 + 2 * 3", {}) == 7
    assert evaluate("2 * 3 + 1", {}) == 7
    assert evaluate("(1 + 2) * 3", {}) == 9


def test_unary_minus():
    assert evaluate("-5", {}) == -5
    assert evaluate("0 - score", {"score": 7}) == -7
    assert evaluate("a - -b", {"a": 5, "b": 3}) == 8  # double negative


def test_negative_numeric_comparison():
    assert evaluate("score == -5", {"score": -5}) is True
    assert evaluate("score < -1", {"score": -5}) is True


def test_arithmetic_with_identifiers():
    env = {"a": 10, "b": 3, "c": 2}
    assert evaluate("a - b - c", env) == 5
    assert evaluate("a * b + c", env) == 32


def test_division_by_zero_returns_none():
    assert evaluate("a / b", {"a": 5, "b": 0}) is None
    assert evaluate("10 / 0", {}) is None


def test_null_propagation_through_arithmetic():
    assert evaluate("a + b", {"a": None, "b": 5}) is None
    assert evaluate("a + b", {"a": 5, "b": None}) is None
    assert evaluate("a * b", {"a": None, "b": 0}) is None
    assert evaluate("a / b", {"a": None, "b": 5}) is None
    assert evaluate("-a", {"a": None}) is None


def test_arithmetic_on_string_returns_none():
    # Type errors are caught at the operator and surface as null, matching
    # the TS evaluator's null-on-error contract.
    assert evaluate("a * b", {"a": "foo", "b": 2}) is None


def test_arithmetic_combines_with_comparison():
    assert evaluate("a + b > 5", {"a": 2, "b": 4}) is True
    assert evaluate("a + b > 10", {"a": 2, "b": 4}) is False
    assert evaluate("a * b == c + d", {"a": 2, "b": 3, "c": 1, "d": 5}) is True


# ---------- count_true ----------

def test_count_true_all_true():
    assert evaluate("count_true([a, b, c])", {"a": True, "b": True, "c": True}) == 3


def test_count_true_mixed():
    assert (
        evaluate("count_true([a, b, c, d])", {"a": True, "b": False, "c": True, "d": False})
        == 2
    )


def test_count_true_skips_null():
    # Per spec: null operands are skipped (not counted as falsy). The integer
    # result is identical to "treated as falsy" for count_true, but the
    # explicit skip semantics matter for documentation and reviewer mental
    # model — null = "not_applicable", not "false".
    assert (
        evaluate("count_true([a, b, c])", {"a": None, "b": True, "c": False}) == 1
    )


def test_count_true_all_null():
    assert (
        evaluate("count_true([a, b, c])", {"a": None, "b": None, "c": None}) == 0
    )


def test_count_true_empty_list():
    assert evaluate("count_true([])", {}) == 0


def test_count_true_with_comparison_operands():
    env = {"a": "yes", "b": "no", "c": "yes"}
    assert (
        evaluate("count_true([a == 'yes', b == 'yes', c == 'yes'])", env) == 2
    )


def test_count_true_threshold_idiom():
    # The RUCAM domain 5 idiom: count exclusions, threshold by tier.
    env = {"hav": "yes", "hbv": "yes", "hcv": "yes", "hev": "yes", "auto": "no"}
    expr = (
        "count_true([hav == 'yes', hbv == 'yes', hcv == 'yes', "
        "hev == 'yes', auto == 'yes']) >= 4"
    )
    assert evaluate(expr, env) is True


def test_count_true_requires_list_arg():
    with pytest.raises((ValueError, NameError)):
        evaluate("count_true(a, b)", {"a": True, "b": False})


# ---------- days_between ----------

def test_days_between_basic():
    assert evaluate("days_between(a, b)", {"a": "2024-04-05", "b": "2024-03-12"}) == 24
    assert evaluate("days_between(a, b)", {"a": "2024-03-12", "b": "2024-04-05"}) == -24
    assert evaluate("days_between(a, b)", {"a": "2024-04-05", "b": "2024-04-05"}) == 0


def test_days_between_null_operand():
    assert evaluate("days_between(a, b)", {"a": None, "b": "2024-04-05"}) is None
    assert evaluate("days_between(a, b)", {"a": "2024-04-05", "b": None}) is None


def test_days_between_invalid_date_string():
    assert evaluate("days_between(a, b)", {"a": "not a date", "b": "2024-04-05"}) is None
    assert evaluate("days_between(a, b)", {"a": "2024/04/05", "b": "2024-03-12"}) is None
    # Datetime with time component is rejected — only YYYY-MM-DD.
    assert (
        evaluate("days_between(a, b)", {"a": "2024-04-05T10:00:00", "b": "2024-03-12"})
        is None
    )


def test_days_between_non_string_operand():
    assert evaluate("days_between(a, b)", {"a": 12345, "b": "2024-03-12"}) is None


def test_days_between_in_threshold_chain():
    # RUCAM domain 1 idiom — score from interval.
    expr = (
        "days_between(a, b) >= 5 AND days_between(a, b) <= 90 ? 2 : "
        "days_between(a, b) < 5 OR days_between(a, b) > 90 ? 1 : 0"
    )
    assert evaluate(expr, {"a": "2024-04-05", "b": "2024-03-12"}) == 2  # 24d → suggestive
    assert evaluate(expr, {"a": "2024-03-13", "b": "2024-03-12"}) == 1  # 1d  → compatible
    assert evaluate(expr, {"a": "2024-08-12", "b": "2024-03-12"}) == 1  # 153d → compatible


# ---------- backward-compatibility safeguards ----------

def test_existing_lung_cancer_idioms_unchanged():
    """The lung-cancer-phenotype guideline must keep evaluating identically."""
    # pre_treatment_anemia_present
    expr = "lowest_hemoglobin_in_window != null AND lowest_hemoglobin_in_window < 12.0"
    assert evaluate(expr, {"lowest_hemoglobin_in_window": 10.5}) is True
    assert evaluate(expr, {"lowest_hemoglobin_in_window": 12.5}) is False
    assert evaluate(expr, {"lowest_hemoglobin_in_window": None}) is False

    # pathology_confirms_lung_cancer
    expr2 = "pathology_report_present == 'yes' AND pathology_lung_primary in ['nsclc','sclc','other_lung']"
    assert (
        evaluate(expr2, {"pathology_report_present": "yes", "pathology_lung_primary": "nsclc"})
        is True
    )
    assert (
        evaluate(expr2, {"pathology_report_present": "no", "pathology_lung_primary": "nsclc"})
        is False
    )

    # lung_cancer_status (ternary chain)
    expr3 = (
        "pathology_confirms_lung_cancer == true ? 'confirmed' : "
        "(clinical_diagnosis_lung_cancer == true OR icd_lung_cancer_present == 'yes') "
        "? 'probable' : 'absent'"
    )
    assert (
        evaluate(
            expr3,
            {
                "pathology_confirms_lung_cancer": True,
                "clinical_diagnosis_lung_cancer": False,
                "icd_lung_cancer_present": "no",
            },
        )
        == "confirmed"
    )
    assert (
        evaluate(
            expr3,
            {
                "pathology_confirms_lung_cancer": False,
                "clinical_diagnosis_lung_cancer": False,
                "icd_lung_cancer_present": "yes",
            },
        )
        == "probable"
    )
