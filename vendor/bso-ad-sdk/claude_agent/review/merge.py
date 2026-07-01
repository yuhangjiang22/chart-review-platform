"""Merge two reviewers' verdict files into MergedRecords + IAA summary."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from claude_agent.review.iaa import compute_agreement, summarize_iaa
from claude_agent.review.schema import (
    AgreementDims, DisagreementType, MentionRecord, MergedRecord,
    ReviewerVerdict, ReviewerVerdictRef,
)


def _load_jsonl(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            yield json.loads(line)


def _live_verdicts_by_mention(path: Path) -> dict[str, ReviewerVerdict]:
    """Read a reviewer's jsonl, return mention_id → latest non-superseded verdict."""
    out: dict[str, ReviewerVerdict] = {}
    for rec in _load_jsonl(path):
        if rec.get("superseded_at"):
            continue
        v = ReviewerVerdict.model_validate(rec)
        out[v.mention_id] = v
    return out


def _disagreement_type(a: AgreementDims) -> Optional[DisagreementType]:
    """Priority: existence > span > type > concept."""
    if a.existence is False:
        return "existence"
    if a.span is False:
        return "span"
    if a.type is False:
        return "type"
    if a.concept is False:
        return "concept"
    return None


def _to_ref(v: ReviewerVerdict) -> ReviewerVerdictRef:
    return ReviewerVerdictRef(
        reviewer_id=v.reviewer_id,
        verdict=v.verdict,
        corrected=v.corrected,
        notes=v.notes,
        ontology_proposal=v.ontology_proposal,
    )


def merge_batch(*, batch_dir: Path) -> dict:
    """Produce merged.jsonl + iaa.json for a batch. Returns the iaa summary dict."""
    manifest = json.loads((batch_dir / "manifest.json").read_text())
    reviewers = manifest["reviewers"]
    if len(reviewers) != 2:
        raise ValueError(f"v1 supports exactly 2 reviewers, got {reviewers}")

    verdict_files = {r: batch_dir / "verdicts" / f"{r}.jsonl" for r in reviewers}
    missing = [r for r, p in verdict_files.items() if not p.exists()]
    if missing:
        raise FileNotFoundError(f"missing reviewer files: {missing}")

    verdicts = {r: _live_verdicts_by_mention(p) for r, p in verdict_files.items()}
    mentions = [MentionRecord.model_validate(rec)
                for rec in _load_jsonl(batch_dir / "mentions.jsonl")]

    merged_records: list[MergedRecord] = []
    for m in mentions:
        v_a = verdicts[reviewers[0]].get(m.mention_id)
        v_b = verdicts[reviewers[1]].get(m.mention_id)
        if v_a is None or v_b is None:
            missing_r = reviewers[0] if v_a is None else reviewers[1]
            raise ValueError(
                f"mention_id={m.mention_id} has no verdict from {missing_r}"
            )
        ref_a, ref_b = _to_ref(v_a), _to_ref(v_b)
        a = compute_agreement(ref_a, ref_b, agent=m)
        dt = _disagreement_type(a)
        merged_records.append(MergedRecord(
            mention_id=m.mention_id,
            agent=m,
            verdicts=[ref_a, ref_b],
            agreement=a,
            needs_adjudication=dt is not None,
            disagreement_type=dt,
        ))

    merged_path = batch_dir / "merged.jsonl"
    with merged_path.open("w", encoding="utf-8") as fh:
        for r in merged_records:
            fh.write(r.model_dump_json() + "\n")

    summary = summarize_iaa(
        batch_id=manifest["batch_id"],
        reviewers=reviewers,
        merged=merged_records,
    )
    (batch_dir / "iaa.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return summary
