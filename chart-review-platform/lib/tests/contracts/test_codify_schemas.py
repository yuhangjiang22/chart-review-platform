"""Codify artifact schemas accept both codify-derived and hand-authored shapes."""

from __future__ import annotations

import re
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
SKILLS = ROOT / ".claude" / "skills"


def _load_schema(name: str) -> Draft202012Validator:
    schema = yaml.safe_load((CONTRACTS / name).read_text())
    return Draft202012Validator(schema)


def _parse_frontmatter(md_path: Path) -> dict:
    text = md_path.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    assert m, f"No frontmatter fences in {md_path}"
    return yaml.safe_load(m.group(1)) or {}


def test_keyword_set_schema_accepts_hand_authored():
    """Existing imaging_findings / pathology_terms / etc. validate."""
    v = _load_schema("keyword_set.schema.json")
    candidates = list(SKILLS.glob("chart-review-*/references/keyword_sets/*.md"))
    assert candidates, "no hand-authored keyword_sets to validate against"
    for md in candidates:
        fm = _parse_frontmatter(md)
        errors = list(v.iter_errors(fm))
        assert not errors, f"{md.relative_to(ROOT)}: {[e.message for e in errors]}"


def test_keyword_set_schema_accepts_codify_derived():
    v = _load_schema("keyword_set.schema.json")
    fm = {
        "id": "kw_lung_cancer_pathology_present",
        "description": "Anchor keywords codified from cohort",
        "version": "2026-05-07",
        "terms": ["biopsy", "pathology report", "spiculated"],
        "term_stats": [
            {"term": "biopsy", "patient_count": 12, "total_count": 27},
        ],
        "derived_from": {
            "cohort_size": 18,
            "cohort_oracle_done_count": 18,
            "codified_at": "2026-05-07T18:42:00Z",
            "guideline_manual_version": "0.4.0",
        },
        "provenance": {"source": "codify-derived"},
    }
    errors = list(v.iter_errors(fm))
    assert not errors, [e.message for e in errors]


def test_code_set_schema_accepts_codify_derived():
    v = _load_schema("code_set.schema.json")
    fm = {
        "id": "codes_lung_cancer_pathology_present",
        "codes": [
            {"concept_id": 4115276, "concept_name": "Malignant tumor of lung",
             "source_table": "condition_occurrence", "patient_count": 9},
        ],
        "prefix_hints": [
            {"prefix": "C34.x", "members": ["C34.10", "C34.11", "C34.31"],
             "patient_count": 11},
        ],
        "derived_from": {
            "cohort_size": 18,
            "codified_at": "2026-05-07T18:42:00Z",
            "guideline_manual_version": "0.4.0",
        },
    }
    errors = list(v.iter_errors(fm))
    assert not errors, [e.message for e in errors]


def test_note_type_filters_schema():
    v = _load_schema("note_type_filters.schema.json")
    fm = {
        "filters": {
            "lung_cancer_pathology_present": {
                "high":   ["pathology", "oncology_consult"],
                "medium": ["discharge_summary"],
            }
        },
        "derived_from": {
            "cohort_size": 18,
            "codified_at": "2026-05-07T18:42:00Z",
            "guideline_manual_version": "0.4.0",
        },
    }
    errors = list(v.iter_errors(fm))
    assert not errors, [e.message for e in errors]
