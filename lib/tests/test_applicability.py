"""Tests for is_applicable_when handling in the derivation evaluator."""

from __future__ import annotations

from chart_review.derivation import (
    NOT_APPLICABLE,
    compute_applicability,
    evaluate_all,
)


def _task(*fields):
    return {
        "task_id": "t",
        "review_unit": "patient",
        "manual_version": "v",
        "source_document_sha": "sha256:0",
        "fields": list(fields),
    }


def test_field_without_gate_is_applicable():
    task = _task(
        {"id": "a", "answer_schema": {"type": "string"}},
    )
    assert compute_applicability(task, {"a": "yes"}) == {"a": "applicable"}


def test_gate_true_is_applicable():
    task = _task(
        {"id": "a", "answer_schema": {"enum": ["yes", "no"]}},
        {
            "id": "b",
            "answer_schema": {"type": "string"},
            "is_applicable_when": "a == 'yes'",
        },
    )
    out = compute_applicability(task, {"a": "yes"})
    assert out["a"] == "applicable"
    assert out["b"] == "applicable"


def test_gate_false_is_not_applicable():
    task = _task(
        {"id": "a", "answer_schema": {"enum": ["yes", "no"]}},
        {
            "id": "b",
            "answer_schema": {"type": "string"},
            "is_applicable_when": "a == 'yes'",
        },
    )
    out = compute_applicability(task, {"a": "no"})
    assert out["b"] == "not_applicable"


def test_gate_with_missing_input_is_unknown():
    task = _task(
        {
            "id": "b",
            "answer_schema": {"type": "string"},
            "is_applicable_when": "a == 'yes'",
        },
    )
    # `a` is referenced by the gate but absent from values
    assert compute_applicability(task, {})["b"] == "unknown"


def test_derived_field_short_circuits_when_gate_false():
    task = _task(
        {"id": "a", "answer_schema": {"enum": ["yes", "no"]}},
        {
            "id": "agg",
            "answer_schema": {"type": "string"},
            "derivation": "a == 'yes' ? 'present' : 'absent'",
            "is_applicable_when": "a == 'yes'",
        },
    )
    derived = evaluate_all(task, {"a": "no"})
    assert derived["agg"] == NOT_APPLICABLE


def test_derived_field_runs_when_gate_true():
    task = _task(
        {"id": "a", "answer_schema": {"enum": ["yes", "no"]}},
        {
            "id": "agg",
            "answer_schema": {"type": "string"},
            "derivation": "a == 'yes' ? 'present' : 'absent'",
            "is_applicable_when": "a == 'yes'",
        },
    )
    derived = evaluate_all(task, {"a": "yes"})
    assert derived["agg"] == "present"


def test_gated_leaf_propagates_to_derived():
    """When a gated leaf is N/A, downstream derivations referencing it see
    the special NOT_APPLICABLE value rather than the agent's stored answer."""
    task = _task(
        {"id": "trigger", "answer_schema": {"enum": ["yes", "no"]}},
        {
            "id": "leaf",
            "answer_schema": {"type": "string"},
            "is_applicable_when": "trigger == 'yes'",
        },
        {
            "id": "report",
            "answer_schema": {"type": "string"},
            "derivation": "leaf == 'not_applicable' ? 'skipped' : leaf",
        },
    )
    # Even if a stale/erroneous value is present for `leaf`, the gate forces N/A
    derived = evaluate_all(task, {"trigger": "no", "leaf": "should-be-ignored"})
    assert derived["report"] == "skipped"
