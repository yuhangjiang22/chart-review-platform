"""ICD-10 prefix-grouping for the codify skill.

When ≥3 leaves of the same parent (e.g. C34.10, C34.11, C34.31 → C34.x)
appear in a code set, emit a parent-prefix hint alongside the literals.
The agent at runtime can choose to widen its query or stay narrow.
Pure prefix grouping; no LLM, no terminology service.
"""

from __future__ import annotations

import re
from collections import defaultdict

# ICD-10 codes have the shape <letter><digits>.<digits>; we group by everything
# before the dot. Codes without a dot have no prefix family.
_ICD_LIKE_RE = re.compile(r"^([A-Z]\d+)\.")
_PREFIX_THRESHOLD = 3


def group_icd_prefixes(codes: list[str]) -> list[dict]:
    """Return prefix-grouping hints for the given list of ICD codes.

    Each hint is a dict ``{"prefix": "C34.x", "members": [<codes>]}``.
    Only emits for prefixes that have ≥3 distinct leaves in `codes`.
    Codes without a dot are ignored (no prefix family).
    """
    by_parent: dict[str, set[str]] = defaultdict(set)
    for code in codes:
        m = _ICD_LIKE_RE.match(code)
        if not m:
            continue
        by_parent[m.group(1)].add(code)
    out = []
    for parent, members in by_parent.items():
        if len(members) >= _PREFIX_THRESHOLD:
            out.append({"prefix": f"{parent}.x", "members": sorted(members)})
    out.sort(key=lambda d: d["prefix"])
    return out
