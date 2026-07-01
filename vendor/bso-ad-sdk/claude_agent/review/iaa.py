"""Per-dimension agreement + Cohen/Fleiss kappa for the review pipeline.

Agreement is computed in four orthogonal dimensions: existence, span, type,
concept. Existence is the gate — when reviewers disagree about whether the
entity exists, the other three dimensions are recorded as None (vacuous).

For the rule table see spec §7.2.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Optional

from claude_agent.review.schema import (
    AgreementDims, CorrectedFields, MentionRecord, ReviewerVerdictRef,
)

_EXISTENCE_DENIERS = {"reject_not_entity", "reject_duplicate",
                      "propose_split", "propose_merge"}


def _both_believe_exists(a: ReviewerVerdictRef, b: ReviewerVerdictRef) -> bool:
    return a.verdict not in _EXISTENCE_DENIERS and b.verdict not in _EXISTENCE_DENIERS


def _existence_agrees(a: ReviewerVerdictRef, b: ReviewerVerdictRef) -> bool:
    return (a.verdict in _EXISTENCE_DENIERS) == (b.verdict in _EXISTENCE_DENIERS)


def _effective_span(v: ReviewerVerdictRef, agent: Optional[MentionRecord]):
    """Return the (start, end) the reviewer believes the mention spans.

    correct_span → use corrected.span. All other verdicts implicitly keep
    the agent's span; we represent that as None (caller compares with both
    sides reporting None as identity)."""
    if v.verdict == "correct_span" and v.corrected and v.corrected.span:
        return (v.corrected.span.start, v.corrected.span.end)
    return None  # "unchanged"


def _effective_type(v: ReviewerVerdictRef):
    if v.verdict == "correct_type" and v.corrected and v.corrected.entity_type:
        return v.corrected.entity_type
    return None


def _effective_concept(v: ReviewerVerdictRef):
    if v.verdict == "correct_concept" and v.corrected and v.corrected.concept_name:
        return v.corrected.concept_name
    return None


def compute_agreement(
    a: ReviewerVerdictRef, b: ReviewerVerdictRef,
    agent: Optional[MentionRecord] = None,
) -> AgreementDims:
    existence = _existence_agrees(a, b)
    if not existence or not _both_believe_exists(a, b):
        return AgreementDims(existence=existence, span=None, type=None, concept=None)
    return AgreementDims(
        existence=True,
        span=_effective_span(a, agent) == _effective_span(b, agent),
        type=_effective_type(a) == _effective_type(b),
        concept=_effective_concept(a) == _effective_concept(b),
    )


def cohens_kappa(pairs: list[tuple]) -> float:
    """Cohen's kappa for two raters over categorical labels.

    pairs is a list of (label_from_rater_a, label_from_rater_b). Labels can
    be any hashable (strings work fine). Returns 1.0 for perfect agreement,
    0.0 for chance, negative for systematic disagreement.
    """
    n = len(pairs)
    if n == 0:
        return 1.0
    p_o = sum(1 for a, b in pairs if a == b) / n
    cat_a = Counter(a for a, _ in pairs)
    cat_b = Counter(b for _, b in pairs)
    cats = set(cat_a) | set(cat_b)
    p_e = sum((cat_a[c] / n) * (cat_b[c] / n) for c in cats)
    if p_e == 1.0:
        return 1.0  # both raters always picked the same single label
    return (p_o - p_e) / (1.0 - p_e)


def _agreement_pairs(merged: list, dim: str) -> list[tuple]:
    """Materialize (alice_label, bob_label) pairs for a kappa dimension."""
    pairs = []
    for m in merged:
        a, b = m.verdicts[0], m.verdicts[1]
        if dim == "existence":
            la = a.verdict in _EXISTENCE_DENIERS
            lb = b.verdict in _EXISTENCE_DENIERS
        elif dim == "concept":
            la = _effective_concept(a) if _both_believe_exists(a, b) else None
            lb = _effective_concept(b) if _both_believe_exists(a, b) else None
        elif dim == "type":
            la = _effective_type(a) if _both_believe_exists(a, b) else None
            lb = _effective_type(b) if _both_believe_exists(a, b) else None
        else:  # span
            la = _effective_span(a, None) if _both_believe_exists(a, b) else None
            lb = _effective_span(b, None) if _both_believe_exists(a, b) else None
        # Use a sentinel string for None so it counts as its own category
        pairs.append((str(la), str(lb)))
    return pairs


def summarize_iaa(*, batch_id: str, reviewers: list[str], merged: list) -> dict:
    """Compute the batch-level iaa.json payload from a list of MergedRecord."""
    total = len(merged)
    needs_adj = sum(1 for m in merged if m.needs_adjudication)
    n_ontology = sum(
        1 for m in merged for v in m.verdicts
        if getattr(v, "ontology_proposal", None) is not None
    )

    kappa = {
        "existence": cohens_kappa(_agreement_pairs(merged, "existence")),
        "entity_type": cohens_kappa(_agreement_pairs(merged, "type")),
        "concept": cohens_kappa(_agreement_pairs(merged, "concept")),
        "span_strict": cohens_kappa(_agreement_pairs(merged, "span")),
        "span_lenient": cohens_kappa(_agreement_pairs(merged, "span")),  # v1: same as strict
    }

    # Per-entity-type concept kappa: kappa for the "concept" dimension grouped
    # by agent.entity_type bucket.
    per_et_buckets: dict[str, list[tuple]] = defaultdict(list)
    for m in merged:
        if not _both_believe_exists(m.verdicts[0], m.verdicts[1]):
            continue
        la = _effective_concept(m.verdicts[0])
        lb = _effective_concept(m.verdicts[1])
        per_et_buckets[m.agent.entity_type].append((str(la), str(lb)))
    per_entity_type_concept_kappa = {
        et: cohens_kappa(pairs) for et, pairs in per_et_buckets.items()
    }

    # Agent-quality correlation by status: agreement_rate per status bucket,
    # collapsed to TWO buckets:
    #   - mapped           = mapped + mapped_uncertain (agent gave a concept)
    #   - novel_candidate  = agent left it empty (no ontology match)
    # The mapped_uncertain distinction is operationally noise from the
    # reviewer-quality angle — what matters is "did the agent provide a concept
    # at all", and for those, did the reviewers agree it was correct.
    status_buckets: dict[str, list[bool]] = defaultdict(list)
    for m in merged:
        agreed = (m.agreement.existence
                  and (m.agreement.span is not False)
                  and (m.agreement.type is not False)
                  and (m.agreement.concept is not False))
        bucket = "mapped" if m.agent.status in ("mapped", "mapped_uncertain") else m.agent.status
        status_buckets[bucket].append(agreed)
    by_status = {
        s: {"agreement_rate": sum(vals) / len(vals) if vals else 0.0,
            "n": len(vals)}
        for s, vals in status_buckets.items()
    }

    return {
        "batch_id": batch_id,
        "reviewers": list(reviewers),
        "n_mentions": total,
        "kappa": kappa,
        "agent_quality_correlation": {"by_status": by_status},
        "n_needs_adjudication": needs_adj,
        "n_ontology_proposals": n_ontology,
        "per_entity_type_concept_kappa": per_entity_type_concept_kappa,
    }
