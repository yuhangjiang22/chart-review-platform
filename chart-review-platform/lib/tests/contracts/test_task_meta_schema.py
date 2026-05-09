# lib/tests/contracts/test_task_meta_schema.py
"""Schema for the on-disk meta.yaml that chart-review-build emits."""

from __future__ import annotations

from pathlib import Path

import yaml
from chart_review.validator import validate_task_meta

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
FIXTURES = ROOT / "lib" / "tests" / "fixtures" / "build-skill"


def _load_yaml(p: Path) -> dict:
    return yaml.safe_load(p.read_text())


def test_known_good_meta_validates():
    meta = _load_yaml(FIXTURES / "known-good" / "meta.yaml")
    result = validate_task_meta(meta, CONTRACTS)
    assert result["status"] == "pass", result["errors"]


def test_known_bad_meta_rejected():
    """The actual broken meta.yaml from the 2026-05-07 test session must fail."""
    meta = _load_yaml(FIXTURES / "known-bad-meta" / "meta.yaml")
    result = validate_task_meta(meta, CONTRACTS)
    assert result["status"] == "fail"
    msg = " ".join(result["errors"])
    assert "task_type" in msg or "manual_version" in msg or "final_output" in msg


def test_unknown_keys_rejected():
    """Schema is closed: stray keys like final_output_field must fail."""
    meta = _load_yaml(FIXTURES / "known-good" / "meta.yaml")
    meta["final_output_field"] = "lung_cancer_status"  # the build-skill bug shape
    result = validate_task_meta(meta, CONTRACTS)
    assert result["status"] == "fail"
    assert "final_output_field" in " ".join(result["errors"])
