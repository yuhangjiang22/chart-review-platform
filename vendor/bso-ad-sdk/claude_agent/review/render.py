"""Terminal rendering for review / adjudication / ontology cards.

All rendering is plain ASCII so output works in any TTY and can be tee'd or
captured to logs without escape-sequence garbage.
"""
from __future__ import annotations

from claude_agent.review.schema import MentionRecord, ReviewerVerdictRef

_SEP = "═" * 71
_RULE = "─"


def _highlight_mention(source: str, start: int, end: int, context_chars: int = 60) -> tuple[str, str]:
    """Return (line_with_brackets, underline_marker_line) for the source slice
    around [start, end). Truncates with ellipses outside the context window."""
    left = max(0, start - context_chars)
    right = min(len(source), end + context_chars)
    prefix = "..." if left > 0 else ""
    suffix = "..." if right < len(source) else ""
    before = source[left:start].replace("\n", " ")
    mention = source[start:end].replace("\n", " ")
    after = source[end:right].replace("\n", " ")
    line = f"{prefix}{before}[{mention}]{after}{suffix}"
    # Underline aligns under [mention]
    pad = len(prefix) + len(before) + 1  # +1 for "["
    marker = " " * pad + "▲" * len(mention)
    return line, marker


def render_review_card(
    *,
    mention: MentionRecord,
    source_text: str,
    batch_id: str,
    reviewer_id: str,
    progress: str,
) -> str:
    line, marker = _highlight_mention(source_text, mention.start, mention.end)
    return (
        f"\n{_SEP}\n"
        f"[batch {batch_id} · reviewer {reviewer_id} · {progress}]\n"
        f"{_SEP}\n"
        f"mention_id: {mention.mention_id}              note_id: {mention.note_id}\n"
        "\n"
        f"── Source (mention highlighted) {_RULE * 36}\n"
        f"{line}\n"
        f"{marker}\n"
        f"  (start={mention.start}, end={mention.end})\n"
        "\n"
        f"── Agent proposal {_RULE * 50}\n"
        f"entity_type:  {mention.entity_type}\n"
        f"concept_name: {mention.concept_name}\n"
        f"status:       {mention.status}\n"
        f"match_kind:   {mention.match_kind.value}\n"
        "\n"
        f"── Your verdict {_RULE * 52}\n"
        "[c] confirm                  [t] correct_type\n"
        "[1] correct_concept          [s] correct_span\n"
        "[r] reject_not_entity        [d] reject_duplicate\n"
        "[/] propose_split            [+] propose_merge\n"
        "[o] add ontology proposal    [?] view alternatives  [n] notes  [q] quit\n"
        "\n"
        "verdict> "
    )


def render_ontology_card(
    *,
    proposal_id: str,
    surface_form: str,
    occurrence_count: int,
    reviewer_proposals: list,
    sample_contexts: list[tuple[str, str]],
    progress: str,
    maintainer_id: str,
) -> str:
    """ASCII card for ontology_cli.py."""
    rendered_revs = []
    for rp in reviewer_proposals:
        rendered_revs.append(
            f"{rp.reviewer_id}: {rp.suggested_name}"
            + (f"  parent: {rp.suggested_parent}" if rp.suggested_parent else "")
        )
        if rp.rationale:
            rendered_revs.append(f"       rationale: {rp.rationale}")
    revs_block = "\n".join(rendered_revs) if rendered_revs else "(none)"

    ctx_block = "\n".join(f"[{cid}] {snippet}" for cid, snippet in sample_contexts)
    return (
        f"\n{_SEP}\n"
        f"[ontology queue · maintainer {maintainer_id} · {progress}]\n"
        f"{_SEP}\n"
        f"surface_form:     \"{surface_form}\"\n"
        f"occurrence_count: {occurrence_count}\n"
        f"proposal_id:      {proposal_id}\n"
        "\n"
        f"── Reviewer suggestions {_RULE * 44}\n"
        f"{revs_block}\n"
        "\n"
        f"── Source contexts (sample) {_RULE * 40}\n"
        f"{ctx_block}\n"
        "\n"
        f"── Your decision {_RULE * 51}\n"
        "[a] accept   [s] accept-as-synonym   [r] reject   [d] defer   [q] quit\n"
        "\n"
        "decision> "
    )


def render_adjudication_card(
    *,
    mention: MentionRecord,
    source_text: str,
    verdicts: list[ReviewerVerdictRef],
    disagreement_type: str,
    batch_id: str,
    adjudicator_id: str,
    progress: str,
) -> str:
    line, marker = _highlight_mention(source_text, mention.start, mention.end)
    rendered_verdicts = []
    for v in verdicts:
        line_v = f"{v.reviewer_id} → {v.verdict}"
        if v.corrected and v.corrected.concept_name:
            line_v += f" → {v.corrected.concept_name}"
        if v.corrected and v.corrected.entity_type:
            line_v += f" → type={v.corrected.entity_type}"
        if v.corrected and v.corrected.span:
            line_v += f" → span=[{v.corrected.span.start}, {v.corrected.span.end})"
        rendered_verdicts.append(line_v)
        if v.notes:
            rendered_verdicts.append(f"        notes: {v.notes}")
        else:
            rendered_verdicts.append("        notes: (none)")
    verdicts_block = "\n".join(rendered_verdicts)

    return (
        f"\n{_SEP}\n"
        f"[batch {batch_id} · adjudicator {adjudicator_id} · {progress}]\n"
        f"{_SEP}\n"
        f"mention_id: {mention.mention_id}              disagreement: {disagreement_type}\n"
        "\n"
        f"── Source {_RULE * 58}\n"
        f"{line}\n"
        f"{marker}\n"
        "\n"
        f"── Agent {_RULE * 59}\n"
        f"concept: {mention.concept_name}     status: {mention.status}\n"
        f"                               match_kind: {mention.match_kind.value}\n"
        "\n"
        f"── Reviewers {_RULE * 56}\n"
        f"{verdicts_block}\n"
        "\n"
        f"── Your decision {_RULE * 51}\n"
        f"[a] take {verdicts[0].reviewer_id}'s  "
        f"[b] take {verdicts[1].reviewer_id}'s  "
        "[n] new value  [s] skip(defer)  [q] quit\n"
        "\n"
        "decision> "
    )
