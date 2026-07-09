"""Adjudication logic: walk merged.jsonl, prompt third party for resolution."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

from claude_agent.review._atomic_io import atomic_append_jsonl, atomic_rewrite_jsonl
from claude_agent.review.schema import (
    AdjudicationFinal, AdjudicationRecord, AgreementDims,
    CorrectedFields, MentionRecord, MergedRecord, ReviewerVerdictRef, Span,
)

_LOG = logging.getLogger(__name__)


def _load_merged(batch_dir: Path) -> list[MergedRecord]:
    rows = []
    for line in (batch_dir / "merged.jsonl").read_text().splitlines():
        line = line.strip()
        if line:
            rows.append(MergedRecord.model_validate_json(line))
    return rows


def _load_adjudicated_ids(batch_dir: Path) -> set[str]:
    """Mention_ids with a live (non-superseded, non-deferred) adjudication.

    Skips superseded records (an earlier decision that was cleared or replaced)
    and deferred records (revisitable). Caller should intersect with the current
    needs_adjudication set if they want to count only relevant decisions.
    """
    path = batch_dir / "adjudication.jsonl"
    if not path.exists():
        return set()
    seen: set[str] = set()
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if rec.get("superseded_at"):
            continue
        if rec.get("deferred"):
            continue
        seen.add(rec["mention_id"])
    return seen


def next_pending_disagreement(batch_dir: Path) -> Optional[MergedRecord]:
    """Return the first mention needing adjudication that hasn't been resolved."""
    done = _load_adjudicated_ids(batch_dir)
    for m in _load_merged(batch_dir):
        if m.needs_adjudication and m.mention_id not in done:
            return m
    return None


def write_adjudication(*, batch_dir: Path, record: AdjudicationRecord) -> None:
    path = batch_dir / "adjudication.jsonl"
    atomic_append_jsonl(path, json.loads(record.model_dump_json()))


def _mention_still_needs_adjudication(batch_dir: Path, mention_id: str) -> bool:
    """Check merged.jsonl: is this mention currently flagged needs_adjudication=true?

    Returns False if merged.jsonl is missing — clearing in that state is harmless.
    """
    merged_path = batch_dir / "merged.jsonl"
    if not merged_path.exists():
        return False
    for line in merged_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("mention_id") == mention_id:
            return bool(rec.get("needs_adjudication"))
    return False


def clear_adjudication(*, batch_dir: Path, mention_id: str) -> None:
    """Mark all live decisions for `mention_id` as superseded without appending
    a replacement. The mention reverts to needs_adjudication=true so the
    adjudicator can redo it from scratch.

    Emits a warning when the mention is currently flagged needs_adjudication=true,
    since the resulting state will block gold compilation until a new
    adjudication record is recorded.
    """
    import datetime as _dt
    path = batch_dir / "adjudication.jsonl"
    if not path.exists():
        return
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if _mention_still_needs_adjudication(batch_dir, mention_id):
        _LOG.warning(
            "clearing adjudication for mention %s which still has "
            "needs_adjudication=true; gold compilation will block until a new "
            "decision is recorded",
            mention_id,
        )

    def _mutate(rows: list[dict]) -> list[dict]:
        for r in rows:
            if r.get("mention_id") == mention_id and not r.get("superseded_at"):
                r["superseded_at"] = now
        return rows

    atomic_rewrite_jsonl(path, _mutate)


def latest_decision_for(batch_dir: Path, mention_id: str) -> Optional[AdjudicationRecord]:
    """Return the latest live AdjudicationRecord for this mention, or None
    if not yet adjudicated (or fully cleared)."""
    path = batch_dir / "adjudication.jsonl"
    if not path.exists():
        return None
    latest: Optional[AdjudicationRecord] = None
    latest_ts = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec["mention_id"] != mention_id or rec.get("superseded_at"):
            continue
        if rec.get("decided_at", "") >= latest_ts:
            latest_ts = rec.get("decided_at", "")
            latest = AdjudicationRecord.model_validate(rec)
    return latest


def take_reviewer_decision(
    *,
    merged: MergedRecord,
    pick_index: int,
    adjudicator_id: str,
    rationale: str,
    decided_at: str,
) -> AdjudicationRecord:
    """Build an AdjudicationRecord where `final` comes from one reviewer's verdict."""
    picked = merged.verdicts[pick_index]
    final = AdjudicationFinal(
        verdict=picked.verdict,
        concept_name=picked.corrected.concept_name if picked.corrected else None,
        entity_type=picked.corrected.entity_type if picked.corrected else None,
        span=picked.corrected.span if picked.corrected else None,
    )
    return AdjudicationRecord(
        mention_id=merged.mention_id,
        reviewer_verdicts=merged.verdicts,
        disagreement_type=merged.disagreement_type,
        adjudicator_id=adjudicator_id,
        final=final,
        rationale=rationale,
        decided_at=decided_at,
        deferred=False,
    )


def defer_decision(
    *,
    merged: MergedRecord,
    adjudicator_id: str,
    decided_at: str,
) -> AdjudicationRecord:
    return AdjudicationRecord(
        mention_id=merged.mention_id,
        reviewer_verdicts=merged.verdicts,
        disagreement_type=merged.disagreement_type,
        adjudicator_id=adjudicator_id,
        final=AdjudicationFinal(verdict="confirm"),  # placeholder; deferred=true
        rationale="(deferred)",
        decided_at=decided_at,
        deferred=True,
    )
