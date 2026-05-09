# lib/tests/contracts/test_file_templates_audit.py
"""Parse the YAML/Markdown code blocks in file-templates.md and validate them.

Catches the failure mode where the template documents one shape but the schema
requires another — drift that would let the skill ship invalid output.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml
from chart_review.validator import (
    validate_criterion_frontmatter,
    validate_task_meta,
)

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
TEMPLATES_MD = (
    ROOT
    / ".claude"
    / "skills"
    / "chart-review-build"
    / "references"
    / "file-templates.md"
)

_FENCE_RE = re.compile(
    r"```(yaml|markdown)\n(.*?)\n```",
    re.DOTALL,
)


def _extract_blocks() -> list[tuple[str, str]]:
    text = TEMPLATES_MD.read_text()
    return [(lang, body) for lang, body in _FENCE_RE.findall(text)]


def test_template_meta_validates():
    """The yaml block under '## meta.yaml' must validate against task-meta.schema.json."""
    blocks = _extract_blocks()
    yaml_blocks = [body for lang, body in blocks if lang == "yaml"]
    # Find the meta.yaml block (heuristic: contains 'task_type:')
    meta_block = next((b for b in yaml_blocks if "task_type:" in b), None)
    assert meta_block is not None, "no meta.yaml template block found"
    # Substitute only documented placeholders the template explicitly leaves blank
    rendered = (
        meta_block
        .replace("<task_id>", "demo")
        .replace("<outcome-first | evidence-first | timeline | hybrid | narrative>", "outcome-first")
        .replace("<2-3 paragraph synthesis of what the chart review answers>", "Demo overview prose.")
        .replace("<who is in scope>", "all patients")
        .replace("<the anchor event, e.g. 'MI hospitalization discharge'>", "demo index event")
        .replace("<name_kebab>", "lookback_24mo")
        .replace("<anchor_id_from_index_anchor>", "index_date")
        .replace("<e.g. -24mo or -P24M>", "-P24M")
        .replace("<e.g. 0d or P0D>", "P0D")
        .replace("<human description, e.g. '30 days post discharge'>", "24-month lookback")
        .replace("<field_id_for_main_outcome>", "demo_status")
    )
    parsed = yaml.safe_load(rendered)

    result = validate_task_meta(parsed, CONTRACTS)
    assert result["status"] == "pass", (
        f"file-templates.md meta.yaml block fails task-meta schema: {result['errors']}"
    )


def test_template_criterion_frontmatter_validates():
    """The markdown criterion template must produce frontmatter that validates."""
    blocks = _extract_blocks()
    md_blocks = [body for lang, body in blocks if lang == "markdown"]
    crit_block = next((b for b in md_blocks if "field_id:" in b), None)
    assert crit_block is not None, "no criterion template block found"

    # Extract frontmatter from the template, substitute documented placeholders only
    fm_match = re.match(r"^---\n(.*?)\n---", crit_block, re.DOTALL)
    assert fm_match, "no --- fences in criterion template"
    rendered = (
        fm_match.group(1)
        .replace("<field_id>", "demo_field")
        .replace("<one sentence question>", "Is X documented?")
        .replace("<id_from_meta.time_windows>", "lookback_24mo")
        .replace("<group_label>", "evidence")
        .replace("<DSL expression>", "demo_field == 'yes'")
        .replace("<code_set_id>", "demo_codes")
        .replace("<edge_case_id>", "demo_edge")
        .replace("<exemplar_id>", "demo_exemplar")
    )
    parsed = yaml.safe_load(rendered)

    result = validate_criterion_frontmatter(parsed, CONTRACTS)
    assert result["status"] == "pass", (
        f"file-templates.md criterion frontmatter fails schema: {result['errors']}"
    )
