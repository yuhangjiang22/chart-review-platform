"""Parse a task document (.md) into a CompiledTask dict.

A task document combines manual prose with structured field blocks.
The parser extracts:
- Frontmatter → top-level metadata
- Each `## Field <id>` block's first ```yaml fence → field structure
- Subsequent `### <Section>` prose → guidance_prose, keyed by normalized section name
- The `## Overview` body → overview_prose
- SHA-256 of the raw markdown bytes → source_document_sha
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

import yaml


_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n(.*)", re.DOTALL)
_FIELD_HEADER_RE = re.compile(r"^##\s+Field\s+`([^`]+)`\s*$", re.MULTILINE)
_SUBSECTION_RE = re.compile(r"^###\s+(.+?)\s*$", re.MULTILINE)
_FENCED_YAML_RE = re.compile(r"```ya?ml\s*\n(.*?)\n```", re.DOTALL)


def _normalize_section_key(heading: str) -> str:
    return re.sub(r"[\s\-]+", "_", heading.strip().lower())


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError("Task document must start with YAML frontmatter (---)")
    front = yaml.safe_load(m.group(1)) or {}
    body = m.group(2)
    return front, body


def _extract_overview(body: str) -> str:
    m = re.search(r"^##\s+Overview\s*\n(.*?)(?=^##\s|\Z)", body, re.MULTILINE | re.DOTALL)
    return m.group(1).strip() if m else ""


def _split_field_sections(body: str) -> list[tuple[str, str]]:
    """Return (field_id, raw section text) pairs in document order."""
    matches = list(_FIELD_HEADER_RE.finditer(body))
    sections: list[tuple[str, str]] = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        sections.append((m.group(1), body[start:end]))
    return sections


def _parse_field(field_id: str, raw: str) -> dict[str, Any]:
    yaml_match = _FENCED_YAML_RE.search(raw)
    if not yaml_match:
        raise ValueError(f"Field `{field_id}` has no fenced YAML block")
    structure = yaml.safe_load(yaml_match.group(1)) or {}
    if "answer_schema" not in structure:
        raise ValueError(f"Field `{field_id}` is missing required `answer_schema`")

    field: dict[str, Any] = {"id": field_id, **structure}

    # Prose subsections after the YAML block
    after_yaml = raw[yaml_match.end():]
    prose_blocks = list(_SUBSECTION_RE.finditer(after_yaml))
    guidance: dict[str, str] = {}
    for i, m in enumerate(prose_blocks):
        key = _normalize_section_key(m.group(1))
        start = m.end()
        end = prose_blocks[i + 1].start() if i + 1 < len(prose_blocks) else len(after_yaml)
        guidance[key] = after_yaml[start:end].strip()
    if guidance:
        field["guidance_prose"] = guidance

    return field


def parse_task_document(path_or_text: str | Path) -> dict[str, Any]:
    """Compile a task document into a CompiledTask dict."""
    if isinstance(path_or_text, Path) or (
        isinstance(path_or_text, str) and Path(path_or_text).exists()
    ):
        path = Path(path_or_text)
        raw_bytes = path.read_bytes()
        text = raw_bytes.decode("utf-8")
    else:
        text = str(path_or_text)
        raw_bytes = text.encode("utf-8")

    front, body = _parse_frontmatter(text)
    overview = _extract_overview(body)
    field_sections = _split_field_sections(body)
    fields = [_parse_field(fid, raw) for fid, raw in field_sections]

    if not fields:
        raise ValueError("Task document has no fields")

    sha = hashlib.sha256(raw_bytes).hexdigest()

    compiled: dict[str, Any] = {
        "task_id": front.get("task_id"),
        "task_type": front.get("task_type"),
        "review_unit": front.get("review_unit"),
        "manual_version": front.get("manual_version"),
        "source_document_sha": f"sha256:{sha}",
        "fields": fields,
    }
    if "index_anchor" in front:
        compiled["index_anchor"] = front["index_anchor"]
    if "time_windows" in front:
        compiled["time_windows"] = front["time_windows"]
    if "final_output" in front:
        compiled["final_output"] = front["final_output"]
    if overview:
        compiled["overview_prose"] = overview

    # Drop None values from required keys would fail validation; keep only present
    return {k: v for k, v in compiled.items() if v is not None}
