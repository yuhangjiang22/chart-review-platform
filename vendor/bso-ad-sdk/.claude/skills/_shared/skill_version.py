"""Read `version:` from a skill's SKILL.md frontmatter.

Used by the upsert / write scripts to stamp the skill version onto every
output JSON, so cross-time benchmark comparisons can detect when a SKILL.md
revision changed agent behaviour. Falls back to 'unknown' when the file
or the field is missing — never blocks the write.
"""

from __future__ import annotations

import re
from pathlib import Path

# Tolerant of leading indentation so `version:` can sit either at top level
# or nested under `metadata:`. VS Code's skill schema flags top-level `version`
# as a non-standard attribute (only argument-hint, compatibility, description,
# disable-model-invocation, license, metadata, name, user-invocable are
# canonical), so the canonical home is under metadata.
_VERSION_RE = re.compile(r"^\s*version:\s*(.+?)\s*$", re.MULTILINE)


def read_skill_version(skill_md: str | Path) -> str:
    """Return the value of `version:` in the YAML frontmatter, or 'unknown'."""
    p = Path(skill_md)
    if not p.is_file():
        return "unknown"
    text = p.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---"):
        return "unknown"
    end = text.find("\n---", 3)
    if end < 0:
        return "unknown"
    frontmatter = text[3:end]
    m = _VERSION_RE.search(frontmatter)
    return m.group(1).strip() if m else "unknown"
