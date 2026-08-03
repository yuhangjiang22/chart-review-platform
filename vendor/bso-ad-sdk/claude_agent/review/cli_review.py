"""Pure functions powering review_cli.py.

The CLI binary just does I/O glue (argparse, stdin, terminal); all logic that
touches a file lives here so tests can drive it with tmp_path.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from claude_agent.review._atomic_io import atomic_append_jsonl, atomic_rewrite_jsonl
from claude_agent.review.schema import CorrectedFields, MentionRecord, OntologyProposalAttachment, ReviewerVerdict, Span


def _verdicts_path(batch_dir: Path, reviewer_id: str) -> Path:
    return batch_dir / "verdicts" / f"{reviewer_id}.jsonl"


def _load_reviewed_ids(batch_dir: Path, reviewer_id: str) -> set[str]:
    """Return the set of mention_ids the reviewer has already produced a
    non-superseded verdict for."""
    path = _verdicts_path(batch_dir, reviewer_id)
    if not path.exists():
        return set()
    latest_per_id: dict[str, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        # An amend writes a new row; the previous row is marked superseded_at.
        # We treat any row without superseded_at as the live verdict.
        if rec.get("superseded_at"):
            continue
        latest_per_id[rec["mention_id"]] = rec
    return set(latest_per_id.keys())


def _iter_mentions(batch_dir: Path):
    path = batch_dir / "mentions.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        yield MentionRecord.model_validate(json.loads(line))


def next_pending_mention(
    *, batch_dir: Path, reviewer_id: str
) -> Optional[MentionRecord]:
    """Return the first mention in batch order that this reviewer has not yet
    produced a live verdict for. Returns None when reviewer is done."""
    reviewed = _load_reviewed_ids(batch_dir, reviewer_id)
    for m in _iter_mentions(batch_dir):
        if m.mention_id not in reviewed:
            return m
    return None


def submit_verdict(*, batch_dir: Path, verdict: ReviewerVerdict) -> None:
    """Append a verdict row. Refuses to write if a live verdict already exists
    for this (reviewer, mention) — callers must use amend() to replace.

    The duplicate-check + append is run inside atomic_rewrite_jsonl so two
    concurrent submits can't both pass the precheck.
    """
    path = _verdicts_path(batch_dir, verdict.reviewer_id)
    new_row = json.loads(verdict.model_dump_json())

    def _mutate(rows: list[dict]) -> list[dict]:
        for r in rows:
            if r.get("mention_id") == verdict.mention_id and not r.get("superseded_at"):
                raise ValueError(
                    f"live verdict already exists for mention_id={verdict.mention_id!r}; "
                    f"use amend() to supersede"
                )
        rows.append(new_row)
        return rows

    atomic_rewrite_jsonl(path, _mutate)


def progress_string(*, batch_dir: Path, reviewer_id: str) -> str:
    total = sum(1 for _ in _iter_mentions(batch_dir))
    done = len(_load_reviewed_ids(batch_dir, reviewer_id))
    return f"{done}/{total} done"


def build_correction_verdict(
    *,
    mention: "MentionRecord",
    reviewer_id: str,
    kind: str,
    new_value,
    notes: str,
    review_duration_ms: int,
    reviewed_at: str,
) -> ReviewerVerdict:
    """Construct a ReviewerVerdict for correct_{concept,type,span}.

    `new_value` is a str for concept/type and a (start, end) tuple for span.
    """
    if kind == "concept":
        return ReviewerVerdict(
            mention_id=mention.mention_id, reviewer_id=reviewer_id,
            verdict="correct_concept",
            corrected=CorrectedFields(concept_name=str(new_value)),
            notes=notes, reviewed_at=reviewed_at, review_duration_ms=review_duration_ms,
        )
    if kind == "type":
        return ReviewerVerdict(
            mention_id=mention.mention_id, reviewer_id=reviewer_id,
            verdict="correct_type",
            corrected=CorrectedFields(entity_type=str(new_value)),
            notes=notes, reviewed_at=reviewed_at, review_duration_ms=review_duration_ms,
        )
    if kind == "span":
        if not (isinstance(new_value, tuple) and len(new_value) == 2):
            raise ValueError(f"correct_span requires (start, end) tuple, got {new_value!r}")
        return ReviewerVerdict(
            mention_id=mention.mention_id, reviewer_id=reviewer_id,
            verdict="correct_span",
            corrected=CorrectedFields(span=Span(start=int(new_value[0]), end=int(new_value[1]))),
            notes=notes, reviewed_at=reviewed_at, review_duration_ms=review_duration_ms,
        )
    raise ValueError(f"unknown correction kind: {kind!r}")


def clear_verdict(*, batch_dir: Path, reviewer_id: str, mention_id: str) -> None:
    """Mark all live verdicts for (reviewer, mention) as superseded without
    appending a replacement. The mention becomes pending again, so the reviewer
    can re-annotate from scratch."""
    import datetime as _dt

    path = _verdicts_path(batch_dir, reviewer_id)
    if not path.exists():
        return
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _mutate(rows: list[dict]) -> list[dict]:
        for r in rows:
            if r.get("mention_id") == mention_id and not r.get("superseded_at"):
                r["superseded_at"] = now
        return rows

    atomic_rewrite_jsonl(path, _mutate)


def amend_verdict(*, batch_dir: Path, verdict: ReviewerVerdict) -> None:
    """Mark all prior live rows for (reviewer, mention) as superseded, then
    append the new row. Both old and new rows remain on disk (audit trail)."""
    import datetime as _dt

    path = _verdicts_path(batch_dir, verdict.reviewer_id)
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    new_row = json.loads(verdict.model_dump_json())

    def _mutate(rows: list[dict]) -> list[dict]:
        for r in rows:
            if r.get("mention_id") == verdict.mention_id and not r.get("superseded_at"):
                r["superseded_at"] = now
        rows.append(new_row)
        return rows

    atomic_rewrite_jsonl(path, _mutate)


_SIMPLE_VERDICTS = {"reject_not_entity", "reject_duplicate", "propose_split", "propose_merge",
                    "concept_name_novel"}


def build_simple_verdict(
    *,
    mention: "MentionRecord",
    reviewer_id: str,
    verdict_kind: str,
    notes: str,
    review_duration_ms: int,
    reviewed_at: str,
) -> ReviewerVerdict:
    """Construct a ReviewerVerdict for verdicts that don't need a corrected field."""
    if verdict_kind not in _SIMPLE_VERDICTS:
        raise ValueError(f"build_simple_verdict only handles {sorted(_SIMPLE_VERDICTS)}, got {verdict_kind!r}")
    return ReviewerVerdict(
        mention_id=mention.mention_id, reviewer_id=reviewer_id,
        verdict=verdict_kind, notes=notes,
        reviewed_at=reviewed_at, review_duration_ms=review_duration_ms,
    )


def attach_ontology_proposal(
    *,
    verdict: ReviewerVerdict,
    attachment: OntologyProposalAttachment,
) -> ReviewerVerdict:
    """Return a copy of `verdict` with `ontology_proposal` set."""
    return verdict.model_copy(update={"ontology_proposal": attachment})
