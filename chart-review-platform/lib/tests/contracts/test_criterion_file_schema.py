# lib/tests/contracts/test_criterion_file_schema.py
"""Schema for the YAML frontmatter of references/criteria/<id>.md files."""

from __future__ import annotations

import re
from pathlib import Path

import yaml
from chart_review.validator import validate_criterion_frontmatter

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
FIXTURES = ROOT / "lib" / "tests" / "fixtures" / "build-skill"


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)


def _load_criterion_file(p: Path) -> tuple[dict, str]:
    """Return (frontmatter_dict, body_text) for a criterion .md file."""
    text = p.read_text()
    m = _FRONTMATTER_RE.match(text)
    assert m, f"missing frontmatter fences in {p}"
    return yaml.safe_load(m.group(1)), m.group(2)


def test_known_good_leaf_validates():
    fm, _ = _load_criterion_file(
        FIXTURES / "known-good" / "references" / "criteria" / "leaf_yes_no.md"
    )
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "pass", result["errors"]


def test_known_good_derived_validates():
    """Derived criterion (is_final_output: true) MUST have a derivation block."""
    fm, _ = _load_criterion_file(
        FIXTURES / "known-good" / "references" / "criteria" / "derived_status.md"
    )
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "pass", result["errors"]
    assert fm.get("derivation") is not None  # sanity


def test_derived_without_derivation_rejected():
    """B4: is_final_output: true with no derivation block must fail."""
    fm, _ = _load_criterion_file(
        FIXTURES / "known-bad-derivation" / "references" / "criteria" / "status.md"
    )
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "fail"
    msg = " ".join(result["errors"])
    assert "derivation" in msg


def test_leaf_without_derivation_passes():
    """is_final_output: false → derivation is optional."""
    fm = {
        "field_id": "x",
        "prompt": "y?",
        "answer_schema": {"type": "enum", "enum": ["yes", "no"]},
        "is_final_output": False,
    }
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "pass", result["errors"]


def test_open_questions_optional_array_of_string():
    """open_questions is optional but, when present, must be an array of non-empty strings."""
    fm = {
        "field_id": "x",
        "prompt": "y?",
        "answer_schema": {"type": "enum", "enum": ["yes", "no"]},
        "is_final_output": False,
        "open_questions": ["confirm ICD-10 code range for X", "verify procedure code"],
    }
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "pass", result["errors"]


def test_open_questions_empty_string_rejected():
    fm = {
        "field_id": "x",
        "prompt": "y?",
        "answer_schema": {"type": "enum", "enum": ["yes", "no"]},
        "is_final_output": False,
        "open_questions": [""],
    }
    result = validate_criterion_frontmatter(fm, CONTRACTS)
    assert result["status"] == "fail"
