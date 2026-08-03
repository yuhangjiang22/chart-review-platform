"""Stable mention_id hashing.

A mention is keyed by (note_id, text, start, end). Same tuple across re-runs of
the agent ⇒ same id ⇒ review records can join new agent runs to old reviews.
Any drift in those four fields ⇒ new id ⇒ prior reviews marked orphan.
"""
from __future__ import annotations

import hashlib

MENTION_ID_LEN = 12


def mention_id(*, note_id: str, text: str, start: int, end: int) -> str:
    """Return a 12-char hex sha1 prefix derived from the four identity fields.

    Keyword-only to prevent positional mistakes — every field is a string or
    int and would silently mis-hash if reordered.

    The payload is length-prefixed (`<len>:<value>` per field) so a field that
    contains the delimiter character can never collide with a different field
    decomposition. Plain `|`-joined strings would let
    `(note_id="c", text="a|b")` collide with `(note_id="c|a", text="b")`.
    """
    parts = [
        f"{len(note_id)}:{note_id}",
        f"{len(text)}:{text}",
        f"{start}",
        f"{end}",
    ]
    payload = "|".join(parts).encode("utf-8")
    return hashlib.sha1(payload).hexdigest()[:MENTION_ID_LEN]
