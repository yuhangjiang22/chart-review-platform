"""Tests for scripts/generate_corpus.py — hand-crafted code path."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
GEN_SCRIPT = ROOT / "scripts" / "generate_corpus.py"


@pytest.fixture()
def gen_module():
    spec = importlib.util.spec_from_file_location("generate_corpus", GEN_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["generate_corpus"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_load_seeds_returns_20(gen_module):
    seeds = gen_module.load_seeds(ROOT / "tools" / "patient_seeds.yaml")
    assert len(seeds) == 20


def test_load_seeds_distribution(gen_module):
    seeds = gen_module.load_seeds(ROOT / "tools" / "patient_seeds.yaml")
    counts = {}
    for s in seeds:
        counts[s["category"]] = counts.get(s["category"], 0) + 1
    assert counts == {
        "confirmed_nsclc": 5,
        "sclc": 3,
        "probable": 4,
        "icd_only": 3,
        "negative": 5,
    }


def test_hand_crafted_patient_directories_exist(gen_module):
    seeds = gen_module.load_seeds(ROOT / "tools" / "patient_seeds.yaml")
    hand_crafted = [s for s in seeds if s.get("hand_crafted")]
    for s in hand_crafted:
        d = ROOT / "corpus" / "patients" / s["id"]
        assert d.is_dir(), f"Missing hand-crafted patient: {s['id']}"
        assert (d / "meta.json").is_file()
        assert (d / "ground_truth.json").is_file()
        assert (d / "notes").is_dir()
        assert (d / "omop").is_dir()


def test_run_idempotent_on_hand_crafted(gen_module, tmp_path):
    """Running generation on hand-crafted patients should be a no-op."""
    seeds = gen_module.load_seeds(ROOT / "tools" / "patient_seeds.yaml")
    hand_crafted = [s for s in seeds if s.get("hand_crafted")][:1]
    # Snapshot current state of patient_neg_hard_01
    pid = hand_crafted[0]["id"]
    meta_path = ROOT / "corpus" / "patients" / pid / "meta.json"
    before = meta_path.read_text()
    gen_module.process_hand_crafted(ROOT / "corpus", hand_crafted[0])
    after = meta_path.read_text()
    assert before == after  # idempotent


def test_process_hand_crafted_raises_on_malformed_json(gen_module, tmp_path):
    """A corrupt meta.json should raise ValueError with the patient_id, not
    silently pass and explode later."""
    pid = "patient_test_corrupt_01"
    pat = tmp_path / "patients" / pid
    (pat / "notes").mkdir(parents=True)
    (pat / "omop").mkdir()
    (pat / "meta.json").write_text("{ this is not json")
    (pat / "ground_truth.json").write_text("{}")
    (pat / "notes" / "2024-01-01__pcp_visit.txt").write_text("note")

    seed = {"id": pid, "hand_crafted": True}
    with pytest.raises(ValueError) as exc_info:
        gen_module.process_hand_crafted(tmp_path, seed)
    assert pid in str(exc_info.value)
    assert "meta.json" in str(exc_info.value)
