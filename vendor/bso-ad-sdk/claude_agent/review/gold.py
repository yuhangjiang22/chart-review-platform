"""Derive gold.jsonl from merged.jsonl + adjudication.jsonl per spec §9."""
from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Optional

from claude_agent.review.schema import (
    AdjudicationRecord, GoldProvenance, GoldRecord, MergedRecord,
    Status, TerminalStatus,
)

_RESTRUCTURING_VERDICTS = {"propose_split", "propose_merge"}


def _load_merged(path: Path) -> list[MergedRecord]:
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            out.append(MergedRecord.model_validate_json(line))
    return out


def _load_adjudications(path: Path) -> dict[str, AdjudicationRecord]:
    """Return live (non-superseded) adjudication records, keyed by mention_id."""
    out: dict[str, AdjudicationRecord] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            rec = AdjudicationRecord.model_validate_json(line)
            if rec.superseded_at:
                continue
            out[rec.mention_id] = rec
    return out


_NOTES_CSV_CACHE: dict[str, dict[str, str]] = {}


def _load_notes_csv(csv_path: Path) -> dict[str, str]:
    key = str(csv_path)
    cached = _NOTES_CSV_CACHE.get(key)
    if cached is not None:
        return cached
    table: dict[str, str] = {}
    try:
        with csv_path.open("r", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                nid = row.get("note_id")
                if nid:
                    table[nid] = row.get("note_text", "") or ""
    except (OSError, csv.Error):
        table = {}
    _NOTES_CSV_CACHE[key] = table
    return table


def _source_text(batch_dir: Path, note_id: str) -> str:
    """Load source text for one note_id from the batch's notes.csv. Returns "" if unavailable."""
    manifest_path = batch_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    csv_str = manifest.get("notes_csv")
    if not csv_str:
        return ""
    table = _load_notes_csv(Path(csv_str))
    return table.get(note_id, "")


def _terminal_status(s: Status) -> TerminalStatus:
    if s == "mapped_uncertain":
        return "mapped"
    return s  # "mapped" or "novel_candidate"


def _resolved_text(agent_text: str, source: str, start: int, end: int,
                   orig_start: int, orig_end: int) -> str:
    """If span was modified and we have source, re-derive text from source[start:end].
    Otherwise keep the agent's original text."""
    if (start, end) != (orig_start, orig_end) and source:
        return source[start:end]
    return agent_text


def _derive_unanimous_gold(m: MergedRecord, source: str) -> GoldRecord:
    """Apply both reviewers' (identical) corrections to the agent record."""
    v = m.verdicts[0]
    concept = (v.corrected.concept_name
               if v.corrected and v.corrected.concept_name
               else m.agent.concept_name)
    etype = (v.corrected.entity_type
             if v.corrected and v.corrected.entity_type
             else m.agent.entity_type)
    if v.corrected and v.corrected.span:
        start, end = v.corrected.span.start, v.corrected.span.end
    else:
        start, end = m.agent.start, m.agent.end
    text = _resolved_text(m.agent.text, source, start, end, m.agent.start, m.agent.end)
    return GoldRecord(
        mention_id=m.mention_id,
        case_id=m.agent.note_id, pmid="",
        text=text, anchor=m.agent.anchor,
        start=start, end=end,
        entity_type=etype,
        concept_name=concept,
        status=_terminal_status(m.agent.status),
        provenance=GoldProvenance(
            agent_proposal_concept=m.agent.concept_name,
            agent_match_kind=m.agent.match_kind,
            review_path="unanimous",
            reviewers=[v.reviewer_id for v in m.verdicts],
            adjudicator_id=None,
            ontology_version=m.agent.ontology_version,
        ),
    )


def _derive_adjudicated_gold(m: MergedRecord, adj: AdjudicationRecord, source: str) -> GoldRecord:
    f = adj.final
    concept = f.concept_name or m.agent.concept_name
    etype = f.entity_type or m.agent.entity_type
    if f.span:
        start, end = f.span.start, f.span.end
    else:
        start, end = m.agent.start, m.agent.end
    text = _resolved_text(m.agent.text, source, start, end, m.agent.start, m.agent.end)
    return GoldRecord(
        mention_id=m.mention_id,
        case_id=m.agent.note_id, pmid="",
        text=text, anchor=m.agent.anchor,
        start=start, end=end,
        entity_type=etype,
        concept_name=concept,
        status=_terminal_status(m.agent.status),
        provenance=GoldProvenance(
            agent_proposal_concept=m.agent.concept_name,
            agent_match_kind=m.agent.match_kind,
            review_path="adjudicated",
            reviewers=[v.reviewer_id for v in m.verdicts],
            adjudicator_id=adj.adjudicator_id,
            ontology_version=m.agent.ontology_version,
        ),
    )


def compile_gold(*, batch_dir: Path) -> tuple[list[GoldRecord], list[MergedRecord]]:
    """Return (gold_records, restructuring_needed_records).

    Raises ValueError if any adjudication is still deferred."""
    merged = _load_merged(batch_dir / "merged.jsonl")
    adjudications = _load_adjudications(batch_dir / "adjudication.jsonl")
    deferred_ids = [m_id for m_id, a in adjudications.items() if a.deferred]
    if deferred_ids:
        raise ValueError(
            f"{len(deferred_ids)} deferred adjudications block gold compilation: "
            f"{deferred_ids[:5]}"
        )

    # Load source text per note_id once (cheap; one per note in batch).
    sources: dict[str, str] = {}
    for m in merged:
        if m.agent.note_id not in sources:
            sources[m.agent.note_id] = _source_text(batch_dir, m.agent.note_id)

    gold: list[GoldRecord] = []
    restructuring: list[MergedRecord] = []
    for m in merged:
        if any(v.verdict in _RESTRUCTURING_VERDICTS for v in m.verdicts):
            restructuring.append(m)
            continue
        src = sources.get(m.agent.note_id, "")
        if m.needs_adjudication:
            adj = adjudications.get(m.mention_id)
            if adj is None:
                raise ValueError(
                    f"mention_id={m.mention_id} needs adjudication but has no "
                    f"live adjudication record.\n"
                    f"\n"
                    f"This usually means an earlier adjudication was cleared or "
                    f"superseded without replacement.\n"
                    f"Fix: log into the workbench as adjudicator and re-decide "
                    f"on mention {m.mention_id}. Then re-run compile_gold.\n"
                    f"\n"
                    f"Stale superseded records (if any) are at: "
                    f"{batch_dir / 'adjudication.jsonl'} (look for "
                    f"superseded_at field)."
                )
            gold.append(_derive_adjudicated_gold(m, adj, src))
        else:
            # Both reject_not_entity → omit; otherwise unanimous
            v0, v1 = m.verdicts
            if v0.verdict == "reject_not_entity" and v1.verdict == "reject_not_entity":
                continue
            gold.append(_derive_unanimous_gold(m, src))

    (batch_dir / "gold.jsonl").write_text(
        "\n".join(g.model_dump_json() for g in gold) + ("\n" if gold else ""),
        encoding="utf-8",
    )
    if restructuring:
        (batch_dir / "restructuring_needed.jsonl").write_text(
            "\n".join(m.model_dump_json() for m in restructuring) + "\n",
            encoding="utf-8",
        )
    return gold, restructuring
