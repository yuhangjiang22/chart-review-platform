"""Batch assembly: results/ner/*.json → review/batches/<id>/mentions.jsonl."""
from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Iterable

from claude_agent.review.ids import mention_id
from claude_agent.review.schema import MentionRecord


def _iter_ner_outputs(results_root: Path, include_note_ids: list[str] | None) -> Iterable[dict]:
    """Yield per-note NER output dicts.

    Primary source: results_root/predictions.json (the canonical artifact
    produced by pipeline/ingest_notes_csv.py — single file, all notes).
    Fallback: legacy per-note <note_id>.json files at results_root (kept for
    backwards compatibility with batches built before consolidation existed).
    """
    predictions_path = results_root / "predictions.json"
    if predictions_path.exists():
        try:
            top = json.loads(predictions_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            top = None
        if isinstance(top, dict) and "predictions" in top:
            top_model = top.get("model", "unknown")
            for note_id, rec in top["predictions"].items():
                if rec.get("status") != "ok":
                    continue
                if include_note_ids and note_id not in include_note_ids:
                    continue
                yield {
                    "note_id": note_id,
                    "person_id": rec.get("person_id"),
                    "entities": rec.get("entities", []),
                    "model": top_model,
                    "skill_version": rec.get("skill_version", "unknown"),
                    "ontology_version": rec.get("ontology_version", "unknown"),
                }
            return

    for f in sorted(results_root.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and "predictions" in data:
            continue
        if include_note_ids and data.get("note_id") not in include_note_ids:
            continue
        yield data


def build_mention_records(results_root: Path, include_note_ids: list[str] | None) -> list[MentionRecord]:
    out: list[MentionRecord] = []
    for data in _iter_ner_outputs(results_root, include_note_ids):
        note_id = data["note_id"]
        person_id = data.get("person_id")
        for e in data["entities"]:
            mid = mention_id(note_id=note_id, text=e["text"],
                             start=int(e["start"]), end=int(e["end"]))
            out.append(MentionRecord(
                mention_id=mid,
                note_id=note_id,
                person_id=person_id,
                text=e["text"],
                anchor=e.get("anchor", e["text"]),
                start=int(e["start"]),
                end=int(e["end"]),
                entity_type=e["entity_type"],
                concept_name=e["concept_name"],
                status=e["status"],
                match_kind=e["match_kind"],
                model=data["model"],
                skill_version=data["skill_version"],
                ontology_version=data.get("ontology_version", "unknown"),
            ))
    return out


def init_batch(
    *,
    results_root: Path,
    review_root: Path,
    batch_id: str,
    reviewers: list[str],
    include_note_ids: list[str] | None = None,
    notes_csv: Path | None = None,
) -> Path:
    """Create review/batches/<batch_id>/ with manifest.json + mentions.jsonl.

    Refuses to overwrite an existing batch directory; the caller must remove or
    use a new batch_id.
    """
    if not reviewers or len(reviewers) < 2:
        raise ValueError("batch needs at least two reviewer ids")
    batch_dir = review_root / "batches" / batch_id
    if batch_dir.exists():
        raise FileExistsError(f"batch directory exists: {batch_dir}")
    batch_dir.mkdir(parents=True)
    (batch_dir / "verdicts").mkdir()

    mentions = build_mention_records(results_root, include_note_ids)

    mentions_path = batch_dir / "mentions.jsonl"
    with mentions_path.open("w", encoding="utf-8") as fh:
        for m in mentions:
            fh.write(m.model_dump_json() + "\n")

    manifest = {
        "batch_id": batch_id,
        "created_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "reviewers": list(reviewers),
        "note_ids": sorted({m.note_id for m in mentions}),
        "n_mentions": len(mentions),
    }
    if notes_csv is not None:
        manifest["notes_csv"] = str(notes_csv.resolve())
    (batch_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return batch_dir
