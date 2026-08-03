"""Ontology version helpers + (Stage 4) proposal aggregation and apply logic."""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Optional

from claude_agent.review._atomic_io import (
    atomic_append_jsonl,
    atomic_rewrite_json,
    atomic_rewrite_jsonl,
)
from claude_agent.review.schema import (
    GoldRecord,
    OntologyProposal,
    ReviewerProposalRef,
    ReviewerVerdict,
)

_LOG = logging.getLogger(__name__)

_PUNCT_RE = re.compile(r"[^\w\s]")
_WHITESPACE_RE = re.compile(r"\s+")


def read_ontology_version(concepts_path: Path) -> str:
    """Return the version string from concepts.json _meta.version.

    Falls back to "unknown" when the file is missing _meta — keeps the
    pipeline working against pre-Stage-1.4 ontologies for one migration cycle.
    """
    try:
        data = json.loads(Path(concepts_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "unknown"
    meta = data.get("_meta") if isinstance(data, dict) else None
    if not isinstance(meta, dict):
        return "unknown"
    v = meta.get("version")
    return v if isinstance(v, str) and v else "unknown"


def normalize_surface_form(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace → underscore."""
    s = text.lower()
    s = _PUNCT_RE.sub(" ", s)
    s = _WHITESPACE_RE.sub("_", s.strip())
    return s


def _iter_gold(review_root: Path):
    for f in sorted(review_root.glob("batches/*/gold.jsonl")):
        for line in f.read_text().splitlines():
            line = line.strip()
            if line:
                yield GoldRecord.model_validate_json(line)


def _iter_verdicts(review_root: Path):
    for f in sorted(review_root.glob("batches/*/verdicts/*.jsonl")):
        for line in f.read_text().splitlines():
            line = line.strip()
            if line:
                v = ReviewerVerdict.model_validate_json(line)
                if v.superseded_at:
                    continue
                yield v


def aggregate_proposals(
    *,
    review_root: Path,
    ontology_root: Path,
    min_occurrences: int = 5,
) -> list[OntologyProposal]:
    """Walk all gold.jsonl + verdict files, aggregate by normalized surface form."""
    by_form: dict[str, dict] = {}

    # Build mention_id → (text, note_id/case_id) index from all batches'
    # mentions.jsonl so we can link reviewer proposals back to source mentions.
    mention_index: dict[str, dict] = {}
    for mf in sorted(review_root.glob("batches/*/mentions.jsonl")):
        for line in mf.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            mid = rec.get("mention_id")
            if not mid:
                continue
            mention_index[mid] = {
                "text": rec.get("text", ""),
                "case_id": rec.get("note_id") or rec.get("case_id") or "",
            }

    # Novel candidates from gold
    for g in _iter_gold(review_root):
        if g.status != "novel_candidate":
            continue
        nf = normalize_surface_form(g.text)
        entry = by_form.setdefault(nf, {
            "surface_form": g.text,  # first-seen surface form
            "normalized_form": nf,
            "case_ids": set(),
            "source_mention_ids": set(),
            "reviewer_proposals": [],
        })
        entry["case_ids"].add(g.case_id)
        if g.mention_id:
            entry["source_mention_ids"].add(g.mention_id)

    # Reviewer proposals
    for v in _iter_verdicts(review_root):
        if v.ontology_proposal is None:
            continue
        # Prefer joining via the mention's surface text (so the reviewer
        # proposal lands on the same bucket as the underlying gold novel
        # candidate). Fall back to suggested_name when the mention isn't
        # in the index.
        mention_info = mention_index.get(v.mention_id) if v.mention_id else None
        join_text = (mention_info or {}).get("text") or v.ontology_proposal.suggested_name
        nf = normalize_surface_form(join_text)
        entry = by_form.setdefault(nf, {
            "surface_form": join_text,
            "normalized_form": nf,
            "case_ids": set(),
            "source_mention_ids": set(),
            "reviewer_proposals": [],
        })
        if mention_info and mention_info.get("case_id"):
            entry["case_ids"].add(mention_info["case_id"])
        if v.mention_id:
            entry["source_mention_ids"].add(v.mention_id)
        entry["reviewer_proposals"].append(ReviewerProposalRef(
            reviewer_id=v.reviewer_id,
            suggested_name=v.ontology_proposal.suggested_name,
            suggested_parent=v.ontology_proposal.suggested_parent,
            rationale=v.ontology_proposal.rationale,
        ))

    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out: list[OntologyProposal] = []
    for nf, e in sorted(by_form.items()):
        if not e["reviewer_proposals"]:
            # Only surface proposals with at least one explicit reviewer
            # endorsement. Bare novel_candidate mentions stay in gold.jsonl
            # as observations but don't pollute the maintainer queue.
            continue
        occurrence_count = len(e["case_ids"])
        out.append(OntologyProposal(
            proposal_id="prop_" + hashlib.sha1(nf.encode("utf-8")).hexdigest()[:12],
            surface_form=e["surface_form"],
            normalized_form=nf,
            occurrence_count=occurrence_count,
            case_ids=sorted(e["case_ids"]),
            source_mention_ids=sorted(e.get("source_mention_ids", set())),
            reviewer_proposals=e["reviewer_proposals"],
            frequency_threshold_met=occurrence_count >= min_occurrences,
            reviewer_proposal_count=len(e["reviewer_proposals"]),
            queued_at=now,
            status="pending",
        ))

    ontology_root.mkdir(parents=True, exist_ok=True)
    lines = []
    for p in out:
        row = p.model_dump()
        row["ready_for_review"] = p.ready_for_review
        lines.append(json.dumps(row))
    (ontology_root / "proposals.jsonl").write_text(
        "\n".join(lines) + ("\n" if lines else ""),
        encoding="utf-8",
    )
    return out


def load_proposals(ontology_root: Path) -> list[OntologyProposal]:
    path = ontology_root / "proposals.jsonl"
    if not path.exists():
        return []
    return [
        OntologyProposal.model_validate_json(line)
        for line in path.read_text().splitlines()
        if line.strip()
    ]


def load_decisions(ontology_root: Path) -> list[dict]:
    path = ontology_root / "decisions.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def load_live_decisions(ontology_root: Path) -> list[dict]:
    """Like load_decisions but skips rows with superseded_at set."""
    return [d for d in load_decisions(ontology_root) if not d.get("superseded_at")]


def latest_decision_for(ontology_root: Path, proposal_id: str) -> Optional[dict]:
    """Return the latest live decision for one proposal, or None."""
    candidates = [d for d in load_live_decisions(ontology_root)
                  if d["proposal_id"] == proposal_id]
    if not candidates:
        return None
    return max(candidates, key=lambda d: d.get("decided_at", ""))


def write_decision(*, ontology_root: Path, decision: dict) -> None:
    path = ontology_root / "decisions.jsonl"
    atomic_append_jsonl(path, decision)


def _proposal_has_reviewer_endorsement(ontology_root: Path, proposal_id: str) -> bool:
    """True when a still-pending proposal currently has reviewer endorsements.

    Used to warn maintainers who clear a decision on an endorsed proposal —
    the proposal will reappear in their queue and needs to be re-decided.
    """
    proposals_path = ontology_root / "proposals.jsonl"
    if not proposals_path.exists():
        return False
    for line in proposals_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("proposal_id") == proposal_id:
            return bool(rec.get("reviewer_proposals"))
    return False


def clear_decision(*, ontology_root: Path, proposal_id: str) -> None:
    """Supersede all live decisions for `proposal_id` without appending a
    replacement. The proposal returns to pending.

    Emits a warning when the underlying proposal still has reviewer
    endorsement — the maintainer will see it again in the next pending
    queue.
    """
    import datetime as _dt
    path = ontology_root / "decisions.jsonl"
    if not path.exists():
        return
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if _proposal_has_reviewer_endorsement(ontology_root, proposal_id):
        _LOG.warning(
            "clearing decision for proposal %s which still has reviewer "
            "endorsement; the proposal will return to the pending maintainer "
            "queue until a new decision is recorded",
            proposal_id,
        )

    def _mutate(rows: list[dict]) -> list[dict]:
        for r in rows:
            if r.get("proposal_id") == proposal_id and not r.get("superseded_at"):
                r["superseded_at"] = now
        return rows

    atomic_rewrite_jsonl(path, _mutate)


def next_pending_proposal(ontology_root: Path) -> Optional[OntologyProposal]:
    """First ready_for_review proposal not yet decided (live decisions only)."""
    decided_ids = {d["proposal_id"] for d in load_live_decisions(ontology_root)}
    for p in load_proposals(ontology_root):
        if p.ready_for_review and p.proposal_id not in decided_ids:
            return p
    return None


def _replay_decisions(
    initial_concepts: dict, decisions: list[dict]
) -> tuple[dict, list[str]]:
    """Replay an append-only decision log to produce final concepts dict.

    Returns (concepts, applied_ids). reverts undo their target.
    """
    out = {k: v for k, v in initial_concepts.items() if k.startswith("_")}
    for et, block in initial_concepts.items():
        if et.startswith("_"):
            continue
        out[et] = {"concepts": list(block["concepts"])}

    applied_ids: list[str] = []
    reverted: set[str] = set()

    # First pass: collect reverted proposal_ids
    for d in decisions:
        if d.get("decision") == "revert" and d.get("reverts_proposal_id"):
            reverted.add(d["reverts_proposal_id"])

    # Second pass: apply non-reverted accepts
    for d in decisions:
        if d.get("decision") == "revert":
            continue
        if d["proposal_id"] in reverted:
            continue
        if d["decision"] == "accept":
            et = d["final"].get("entity_type")
            if not et:
                raise ValueError(
                    f"decision for proposal {d.get('proposal_id')!r} is missing "
                    f"entity_type; accept-side validation should have populated "
                    f"it. Refusing to silently default."
                )
            block = out.setdefault(et, {"concepts": []})
            label = d["final"]["concept_name"]
            if any(c["label"] == label for c in block["concepts"]):
                continue  # already present
            block["concepts"].append({
                "label": label,
                "parent_label": d["final"].get("parent"),
                "depth": None,  # depth recompute is a v2 concern
            })
            applied_ids.append(d["proposal_id"])
        elif d["decision"] == "accept-as-synonym":
            target = d["final"]["synonym_target"]
            for block in out.values():
                if not isinstance(block, dict) or "concepts" not in block:
                    continue
                for c in block["concepts"]:
                    if c["label"] == target:
                        c.setdefault("synonyms", []).append(d.get("proposal_id"))
                        break
            applied_ids.append(d["proposal_id"])
        # 'reject' and 'defer' are no-ops on concepts.json

    return out, applied_ids


def apply_decisions(
    *,
    ontology_root: Path,
    new_version: str,
    review_root: Optional[Path] = None,
    rebuild: bool = False,
) -> tuple[Path, list[str]]:
    """Apply decisions.jsonl to concepts.json. Returns (new_concepts_path, applied_ids).

    rebuild=True replays the full decision log from scratch (needed when
    handling revert). Otherwise only decisions not yet in _meta.decisions_applied
    are applied.
    """
    concepts_path = ontology_root / "concepts.json"
    if not concepts_path.exists():
        raise FileNotFoundError(f"concepts.json missing at {concepts_path}")

    decisions = load_decisions(ontology_root)
    # Read once to compute downstream "affected" labels; the mutator does its
    # own internal read under the flock for the actual rewrite.
    already_applied = set(
        json.loads(concepts_path.read_text(encoding="utf-8"))
        .get("_meta", {}).get("decisions_applied", [])
    )
    # `applied_holder` survives the closure so we can return the final
    # decisions_applied list after atomic_rewrite_json completes.
    applied_holder: dict[str, list[str]] = {"ids": []}

    def _mutate_concepts(concepts: dict) -> dict:
        already_applied = set(concepts.get("_meta", {}).get("decisions_applied", []))
        if rebuild:
            new_concepts, applied = _replay_decisions(concepts, decisions)
            reverted_ids = {d["reverts_proposal_id"] for d in decisions
                            if d.get("decision") == "revert"
                            and d.get("reverts_proposal_id")}
            new_applied = [x for x in applied if x not in reverted_ids]
            new_concepts["_meta"] = {
                "version": new_version,
                "generated_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "decisions_applied": new_applied,
            }
            for et, block in list(new_concepts.items()):
                if et.startswith("_"):
                    continue
                block["concepts"] = [
                    c for c in block["concepts"]
                    if not any(d.get("decision") == "accept"
                               and d["proposal_id"] in reverted_ids
                               and d["final"]["concept_name"] == c["label"]
                               for d in decisions)
                ]
        else:
            pending = [d for d in decisions if d["proposal_id"] not in already_applied
                       and d.get("decision") != "revert"]
            new_concepts, just_applied = _replay_decisions(concepts, pending)
            new_concepts["_meta"] = {
                "version": new_version,
                "generated_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "decisions_applied": sorted(set(list(already_applied) + just_applied)),
            }
        applied_holder["ids"] = new_concepts["_meta"]["decisions_applied"]
        return new_concepts

    atomic_rewrite_json(concepts_path, _mutate_concepts)

    # Affected mentions: any novel_candidate in any gold.jsonl whose
    # normalized surface_form matches a newly added concept's normalized label.
    affected = []
    if review_root is not None:
        added_labels = set()
        for d in decisions:
            if d.get("decision") == "accept" and d["proposal_id"] not in already_applied:
                added_labels.add(normalize_surface_form(d["final"]["concept_name"]))
        if added_labels:
            for f in sorted(review_root.glob("batches/*/gold.jsonl")):
                for line in f.read_text().splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    rec = json.loads(line)
                    if rec.get("status") != "novel_candidate":
                        continue
                    if normalize_surface_form(rec.get("text", "")) in added_labels:
                        affected.append(rec)
            if affected:
                affected_dir = ontology_root / "affected_by_ontology_bump"
                affected_dir.mkdir(exist_ok=True)
                (affected_dir / f"{new_version}.jsonl").write_text(
                    "\n".join(json.dumps(r, ensure_ascii=False) for r in affected) + "\n",
                    encoding="utf-8",
                )

    return concepts_path, applied_holder["ids"]
