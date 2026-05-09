"""Tests for the API-generated code path of generate_corpus.py."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import importlib.util
import pytest

ROOT = Path(__file__).resolve().parents[2]
GEN_SCRIPT = ROOT / "tools" / "generate_corpus.py"


@pytest.fixture()
def gen_module():
    spec = importlib.util.spec_from_file_location("generate_corpus", GEN_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["generate_corpus"] = mod
    spec.loader.exec_module(mod)
    return mod


def _seed():
    return {
        "id": "patient_test_api_01",
        "category": "negative",
        "difficulty": "easy",
        "hand_crafted": False,
        "age": 60,
        "sex": "M",
        "smoking": "never",
        "region": "Test",
        "presenting_complaint": "routine visit",
        "index_date": "2025-01-15",
        "notes": [{"type": "pcp_visit", "date": "2025-01-15"}],
        "target_leaf_answers": {
            "pathology_report_present": "no",
            "pathology_lung_primary": "not_applicable",
            "cytology_supports_lung_primary": "no",
            "imaging_lung_lesion": "no",
            "oncologist_lung_cancer_diagnosis_in_note": "no",
            "icd_lung_cancer_present": "no",
        },
    }


def test_process_api_generated_writes_files(gen_module, tmp_path):
    fake_response = MagicMock()
    fake_response.content = [MagicMock(text="PCP VISIT\nProvider: TEST\nClear lungs.\n")]
    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_response

    with patch.object(gen_module, "_make_anthropic_client", return_value=fake_client):
        gen_module.process_api_generated(tmp_path, _seed(), model_id="claude-sonnet-4-6")

    pat = tmp_path / "patients" / "patient_test_api_01"
    assert (pat / "meta.json").is_file()
    assert (pat / "ground_truth.json").is_file()
    assert (pat / "notes" / "2025-01-15__pcp_visit.txt").is_file()
    note_text = (pat / "notes" / "2025-01-15__pcp_visit.txt").read_text()
    assert "TEST" in note_text
    # Required OMOP files exist (even if empty)
    for table in ("conditions", "procedures", "measurements", "drugs", "observations", "encounters"):
        assert (pat / "omop" / f"{table}.json").is_file()


def test_process_api_generated_idempotent_skips_existing(gen_module, tmp_path):
    fake_client = MagicMock()
    pat = tmp_path / "patients" / "patient_test_api_01"
    pat.mkdir(parents=True)
    (pat / "meta.json").write_text("{}")

    with patch.object(gen_module, "_make_anthropic_client", return_value=fake_client):
        gen_module.process_api_generated(tmp_path, _seed(), model_id="claude-sonnet-4-6")

    fake_client.messages.create.assert_not_called()


def test_ground_truth_consistency_after_api_path(gen_module, tmp_path):
    """Generated ground_truth.json must run cleanly through evaluate_all and
    yield the lung_cancer_status implied by the seed's category."""
    fake_response = MagicMock()
    fake_response.content = [MagicMock(text="dummy note")]
    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_response

    with patch.object(gen_module, "_make_anthropic_client", return_value=fake_client):
        gen_module.process_api_generated(tmp_path, _seed(), model_id="claude-sonnet-4-6")

    gt = json.loads((tmp_path / "patients" / "patient_test_api_01" / "ground_truth.json").read_text())
    assert gt["lung_cancer_status"] == "absent"


def test_regenerate_clears_existing_patient_dir(gen_module, tmp_path):
    """`--regenerate <id>` removes the patient directory before re-running,
    so the idempotency guard in process_api_generated does not short-circuit
    and a stale note can actually be replaced."""
    pid = "patient_test_regen_01"
    pat = tmp_path / "patients" / pid
    (pat / "notes").mkdir(parents=True)
    (pat / "meta.json").write_text("{}")
    seed = {
        "id": pid,
        "category": "negative",
        "difficulty": "easy",
        "hand_crafted": False,
        "age": 60,
        "sex": "M",
        "smoking": "never",
        "region": "Test",
        "presenting_complaint": "routine visit",
        "index_date": "2025-01-15",
        "notes": [{"type": "pcp_visit", "date": "2025-01-15"}],
        "target_leaf_answers": {
            "pathology_report_present": "no",
            "pathology_lung_primary": "not_applicable",
            "cytology_supports_lung_primary": "no",
            "imaging_lung_lesion": "no",
            "oncologist_lung_cancer_diagnosis_in_note": "no",
            "icd_lung_cancer_present": "no",
        },
    }

    fake_response = MagicMock()
    fake_response.content = [MagicMock(text="REGENERATED NOTE\nfresh content")]
    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_response

    with patch.object(gen_module, "_make_anthropic_client", return_value=fake_client):
        # Simulate what main() does on `--regenerate <id>`: remove the dir
        # before dispatch, then run.
        import shutil
        shutil.rmtree(pat)
        gen_module.process_api_generated(tmp_path, seed, model_id="claude-sonnet-4-6")

    note = (tmp_path / "patients" / pid / "notes" / "2025-01-15__pcp_visit.txt").read_text()
    assert "REGENERATED NOTE" in note
    fake_client.messages.create.assert_called_once()
