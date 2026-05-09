"""Verify the corpus JSON Schemas exist and accept canonical examples."""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def test_meta_schema_accepts_canonical_example():
    schema = _load(CORPUS / "schemas" / "meta.schema.json")
    sample = {
        "patient_id": "patient_001",
        "category": "confirmed_nsclc",
        "demographics": {"age": 68, "sex": "F"},
        "smoking": "30 pack-years, quit 2018",
        "index_date": "2024-12-09",
        "doc_types": ["ct_chest", "surgical_pathology", "oncology_progress"],
        "generated_by": "hand",
    }
    Draft202012Validator(schema).validate(sample)


def test_ground_truth_schema_accepts_canonical_example():
    schema = _load(CORPUS / "schemas" / "ground_truth.schema.json")
    sample = {
        "patient_id": "patient_001",
        "category": "confirmed_nsclc",
        "lung_cancer_status": "confirmed",
        "leaf_answers": {
            "pathology_report_present": "yes",
            "pathology_lung_primary": "nsclc",
            "cytology_supports_lung_primary": "not_applicable",
            "imaging_lung_lesion": "yes",
            "oncologist_lung_cancer_diagnosis_in_note": "yes",
            "icd_lung_cancer_present": "yes",
        },
        "applicability": {"cytology_supports_lung_primary": "not_applicable"},
        "expected_contradicting_evidence_fields": [],
        "difficulty": "easy",
        "difficulty_notes": "Clean confirmed-NSCLC.",
    }
    Draft202012Validator(schema).validate(sample)


def test_index_schema_accepts_canonical_example():
    schema = _load(CORPUS / "schemas" / "index.schema.json")
    sample = {
        "generated_at": "2026-04-29T00:00:00Z",
        "model_id": "claude-sonnet-4-6",
        "git_sha_at_generation": "a55011f",
        "patients": [
            {
                "patient_id": "patient_001",
                "category": "confirmed_nsclc",
                "difficulty": "easy",
                "headline": "68F, hemoptysis, NSCLC adenocarcinoma confirmed by surgical pathology.",
            }
        ],
    }
    Draft202012Validator(schema).validate(sample)
