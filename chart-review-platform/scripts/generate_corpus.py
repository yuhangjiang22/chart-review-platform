#!/usr/bin/env python3
"""Generate the synthetic patient corpus.

Reads scripts/patient_seeds.yaml; for each entry:

- hand_crafted: true    — validates that the patient directory + notes exist;
                          regenerates meta.json + ground_truth.json from
                          existing committed files (idempotent — does not
                          overwrite if content unchanged).

- hand_crafted: false   — calls Claude API once per note (one
                          client.messages.create per note in seed["notes"]),
                          then writes meta.json + ground_truth.json + per-
                          table OMOP files. Idempotent: skips patients
                          whose meta.json already exists. Use --regenerate
                          <id> to force re-creation.

Usage:
    chart-review-platform/.venv/bin/python scripts/generate_corpus.py
    chart-review-platform/.venv/bin/python scripts/generate_corpus.py --regenerate <patient_id>
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


def load_seeds(seeds_yaml: Path) -> list[dict[str, Any]]:
    return yaml.safe_load(seeds_yaml.read_text())


def process_hand_crafted(corpus_root: Path, seed: dict[str, Any]) -> None:
    """Validate that a hand-crafted patient is fully committed.

    Idempotent — does not overwrite committed files. Raises if required
    files are missing or any committed JSON file is malformed.
    """
    pid = seed["id"]
    pat_dir = corpus_root / "patients" / pid
    if not pat_dir.is_dir():
        raise FileNotFoundError(f"Hand-crafted patient missing: {pat_dir}")
    for required in ("meta.json", "ground_truth.json"):
        path = pat_dir / required
        if not path.is_file():
            raise FileNotFoundError(f"{pid} missing {required}")
        try:
            json.loads(path.read_text())
        except json.JSONDecodeError as e:
            raise ValueError(f"{pid} {required} is not valid JSON: {e}") from e
    if not (pat_dir / "notes").is_dir() or not list((pat_dir / "notes").glob("*.txt")):
        raise FileNotFoundError(f"{pid} has no notes/")
    if not (pat_dir / "omop").is_dir():
        raise FileNotFoundError(f"{pid} has no omop/")


def _make_anthropic_client():
    """Lazy import + construct the Anthropic client.

    Separated for testability — tests patch this to return a mock.
    """
    import anthropic  # type: ignore
    return anthropic.Anthropic()


_NOTE_PROMPT_TEMPLATE = """\
You are generating a single synthetic clinical note for a chart-review benchmark corpus.

Patient context:
- ID: {patient_id}
- Category: {category}
- Demographics: {age}{sex}, {region}
- Smoking: {smoking}
- Presenting complaint: {presenting_complaint}
- Index date: {index_date}

Note to generate:
- Type: {note_type}
- Date: {note_date}

Target ground-truth leaf answers (do NOT state these explicitly in the note;
they are the conclusions a chart reviewer should arrive at after reading the
chart):

{target_answers}

Write a clinically realistic note ≤ 2000 characters. Use plausible clinical
language (HPI, exam, assessment, plan as appropriate to the note type).
Avoid stating "the answer is X." Sign with a plausible provider name and the
date. Output ONLY the note text — no preamble, no markdown fences.
"""


def _omop_skeleton(seed: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Minimal OMOP rows for an API-generated patient.

    Populates only enough to back the target leaf answers — e.g., a C34
    code if icd_lung_cancer_present='yes'. Real richness comes from the
    notes; OMOP here is a stub that the agent can grep on.
    """
    target = seed["target_leaf_answers"]
    rows: dict[str, list[dict[str, Any]]] = {
        "conditions": [],
        "procedures": [],
        "measurements": [],
        "drugs": [],
        "observations": [
            {
                "row_id": 90001,
                "concept_id": 4275495,
                "concept_name": "Smoking status",
                "value": seed["smoking"],
                "date": seed["index_date"],
            }
        ],
        "encounters": [],
    }
    if target.get("icd_lung_cancer_present") == "yes":
        rows["conditions"].append({
            "row_id": 50001,
            "concept_id": 4115276,
            "concept_name": "Malignant neoplasm of bronchus or lung",
            "icd10cm": "C34.10",
            "status": "active",
            "date": seed["index_date"],
        })
    return rows


def process_api_generated(
    corpus_root: Path,
    seed: dict[str, Any],
    *,
    model_id: str,
) -> None:
    """Generate one patient by calling the Claude API once per note.

    Idempotent at the patient level: if patients/<id>/meta.json already
    exists, returns immediately without API calls.
    """
    pid = seed["id"]
    pat_dir = corpus_root / "patients" / pid
    if (pat_dir / "meta.json").is_file():
        return  # already generated; --regenerate would have removed the dir

    pat_dir.mkdir(parents=True, exist_ok=True)
    (pat_dir / "notes").mkdir(exist_ok=True)
    (pat_dir / "omop").mkdir(exist_ok=True)

    # Generate the notes
    client = _make_anthropic_client()
    for note in seed["notes"]:
        out_path = pat_dir / "notes" / f"{note['date']}__{note['type']}.txt"
        prompt = _NOTE_PROMPT_TEMPLATE.format(
            patient_id=pid,
            category=seed["category"],
            age=seed["age"],
            sex=seed["sex"],
            region=seed["region"],
            smoking=seed["smoking"],
            presenting_complaint=seed["presenting_complaint"],
            index_date=seed["index_date"],
            note_type=note["type"],
            note_date=note["date"],
            target_answers=json.dumps(seed["target_leaf_answers"], indent=2),
        )
        response = client.messages.create(
            model=model_id,
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text
        if len(text) > 3000:
            raise ValueError(f"{pid} {note['type']}: generated note exceeds 3000 chars")
        out_path.write_text(text)

    # meta.json
    meta = {
        "patient_id": pid,
        "category": seed["category"],
        "demographics": {"age": seed["age"], "sex": seed["sex"], "region": seed["region"]},
        "smoking": seed["smoking"],
        "index_date": seed["index_date"],
        "doc_types": [n["type"] for n in seed["notes"]],
        "generated_by": "claude_api",
        "generation_run_id": model_id,
    }
    (pat_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")

    # ground_truth.json
    target = seed["target_leaf_answers"]
    full_leaf = {
        "pathology_report_present": target.get("pathology_report_present", "no"),
        "pathology_lung_primary": target.get("pathology_lung_primary", "not_applicable"),
        "cytology_supports_lung_primary": target.get("cytology_supports_lung_primary", "no"),
        "imaging_lung_lesion": target.get("imaging_lung_lesion", "no"),
        "oncologist_lung_cancer_diagnosis_in_note": target.get("oncologist_lung_cancer_diagnosis_in_note", "no"),
        "icd_lung_cancer_present": target.get("icd_lung_cancer_present", "no"),
    }
    applicability = {}
    if full_leaf["pathology_report_present"] == "yes":
        applicability["cytology_supports_lung_primary"] = "not_applicable"
    else:
        applicability["pathology_lung_primary"] = "not_applicable"
        applicability["cytology_supports_lung_primary"] = "applicable"
    # Compute final phenotype label deterministically from the lung-cancer task derivations
    if full_leaf["pathology_report_present"] == "yes" and full_leaf["pathology_lung_primary"] in ("nsclc", "sclc", "other_lung"):
        status = "confirmed"
    elif full_leaf["imaging_lung_lesion"] == "yes" and full_leaf["oncologist_lung_cancer_diagnosis_in_note"] == "yes":
        status = "probable"
    elif full_leaf["icd_lung_cancer_present"] == "yes":
        status = "probable"
    else:
        status = "absent"
    gt = {
        "patient_id": pid,
        "category": seed["category"],
        "lung_cancer_status": status,
        "leaf_answers": full_leaf,
        "applicability": applicability,
        "expected_contradicting_evidence_fields": [],
        "difficulty": "easy",
        "difficulty_notes": f"API-generated. Seed: {seed.get('headline', seed['presenting_complaint'])}.",
    }
    (pat_dir / "ground_truth.json").write_text(json.dumps(gt, indent=2) + "\n")

    # OMOP skeleton
    omop = _omop_skeleton(seed)
    for table, rows in omop.items():
        (pat_dir / "omop" / f"{table}.json").write_text(json.dumps(rows, indent=2) + "\n")


def write_index(corpus_root: Path, seeds: list[dict[str, Any]], model_id: str) -> None:
    """Regenerate corpus/index.json from the seeds + the actually-present files."""
    patients = []
    for s in seeds:
        pid = s["id"]
        meta_path = corpus_root / "patients" / pid / "meta.json"
        if not meta_path.is_file():
            continue  # API-generated and not yet produced
        meta = json.loads(meta_path.read_text())
        patients.append({
            "patient_id": pid,
            "category": meta["category"],
            "difficulty": s["difficulty"],
            "headline": s.get("headline", ""),
        })
    idx = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "model_id": model_id,
        "patients": patients,
    }
    (corpus_root / "index.json").write_text(json.dumps(idx, indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--seeds",
        type=Path,
        default=Path(__file__).resolve().parent / "patient_seeds.yaml",
    )
    p.add_argument(
        "--corpus-root",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "corpus",
    )
    p.add_argument("--regenerate", help="patient_id to force regenerate")
    p.add_argument("--model-id", default="claude-sonnet-4-6")
    args = p.parse_args(argv)

    seeds = load_seeds(args.seeds)
    for s in seeds:
        if s.get("hand_crafted"):
            process_hand_crafted(args.corpus_root, s)
        else:
            if args.regenerate and args.regenerate != s["id"]:
                continue
            if args.regenerate == s["id"]:
                # `--regenerate` means "force re-create this patient." The
                # idempotency guard inside process_api_generated returns early
                # if meta.json exists, so we have to clear the directory first.
                pat_dir = Path(args.corpus_root) / "patients" / s["id"]
                if pat_dir.exists():
                    import shutil
                    shutil.rmtree(pat_dir)
                    print(f"[regen] cleared {pat_dir}")
            print(f"[gen] {s['id']}…")
            process_api_generated(args.corpus_root, s, model_id=args.model_id)
    write_index(args.corpus_root, seeds, args.model_id)
    print(f"corpus/index.json regenerated with {len(seeds)} seeds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
