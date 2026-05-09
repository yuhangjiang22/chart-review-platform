"""Verify every note-source evidence quote exists at its claimed offsets.

Runs against a ReviewRecord + a function that maps note_id → full text.
Whitespace-tolerant: collapses runs of whitespace before comparison.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable


def _normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _check_one_quote(
    label: str,
    ev: dict[str, Any],
    get_note_text: Callable[[str], str],
) -> tuple[str, str]:
    """Return ('pass'|'fail', detail_msg). Skips non-note evidence."""
    if ev.get("source") != "note":
        return ("skip", "")
    note_id = ev["note_id"]
    try:
        text = get_note_text(note_id)
    except Exception as e:
        return ("fail", f"{label} note_not_found: {note_id} ({e})")
    start, end = ev["span_offsets"]
    excerpt = text[start:end]
    quote = ev["verbatim_quote"]
    if excerpt == quote:
        return ("pass", "")
    if _normalize_ws(excerpt) == _normalize_ws(quote):
        return ("pass", f"{label} whitespace-normalized match (note {note_id} [{start}:{end}])")
    return (
        "fail",
        f"{label} mismatch in {note_id} [{start}:{end}]: "
        f"expected {quote!r}, got {excerpt!r}",
    )


def check_assessment(
    assessment: dict[str, Any],
    get_note_text: Callable[[str], str],
) -> dict[str, Any]:
    details: list[str] = []
    pass_count = 0
    fail_count = 0

    for i, ev in enumerate(assessment.get("evidence", [])):
        status, msg = _check_one_quote(f"evidence[{i}]", ev, get_note_text)
        if status == "pass":
            pass_count += 1
            if msg:
                details.append(msg)
        elif status == "fail":
            fail_count += 1
            details.append(msg)

    # Contradicting evidence quotes must also verify against source notes —
    # an agent cannot claim it weighed evidence it cannot cite verbatim.
    for i, item in enumerate(assessment.get("contradicting_evidence", [])):
        ev = item.get("evidence") or {}
        status, msg = _check_one_quote(f"contradicting_evidence[{i}]", ev, get_note_text)
        if status == "pass":
            pass_count += 1
            if msg:
                details.append(msg)
        elif status == "fail":
            fail_count += 1
            details.append(msg)

    if fail_count == 0 and pass_count == 0:
        return {"status": "pass", "details": []}
    if fail_count == 0:
        return {"status": "pass", "details": details}
    if pass_count == 0:
        return {"status": "fail", "details": details}
    return {"status": "partial", "details": details}


def check_record(
    record: dict[str, Any],
    notes_dir: Path,
) -> list[dict[str, Any]]:
    """Run faithfulness against a ReviewRecord, reading note text from notes_dir."""
    cache: dict[str, str] = {}

    def get_note(note_id: str) -> str:
        if note_id not in cache:
            path = notes_dir / f"{note_id}.txt"
            if not path.exists():
                raise FileNotFoundError(str(path))
            cache[note_id] = path.read_text()
        return cache[note_id]

    return [
        {
            "field_id": a["field_id"],
            **check_assessment(a, get_note),
        }
        for a in record.get("criterion_assessments", [])
    ]
