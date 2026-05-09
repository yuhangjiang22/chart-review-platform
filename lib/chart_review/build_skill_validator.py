# lib/chart_review/build_skill_validator.py
"""End-to-end validator for a chart-review-build skill output package.

Walks ``<package>/meta.yaml`` and ``<package>/references/criteria/*.md``,
runs each through the relevant JSON Schema, and adds a body-prose check
that no ``# TODO`` markers ship in extraction guidance.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import yaml

from chart_review.derivation import evaluate as _evaluate_derivation
from chart_review.validator import (
    validate_task_meta,
    validate_criterion_frontmatter,
)

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"

_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)
_TODO_RE = re.compile(r"#\s*TODO", re.IGNORECASE)

# Trigger phrase sets for the time-window discipline heuristic (PS-3).
# Both lists are case-insensitive and matched on word-boundary regexes.
_POINT_IN_TIME_PHRASES = [
    "at index",
    "at the index date",
    "at presentation",
    "this admission",
    "currently",
    "today",
    "now",
]
_WINDOWED_PHRASES = [
    "history of",
    "any prior",
    "previous",
    "lookback",
    "ever",
    "prior",
    "past",
]


def _phrase_regex(phrases: list[str]) -> re.Pattern:
    # \b word-boundary on each end; phrase may contain spaces.
    return re.compile(
        r"\b(" + "|".join(re.escape(p) for p in phrases) + r")\b",
        re.IGNORECASE,
    )


_POINT_IN_TIME_RE = _phrase_regex(_POINT_IN_TIME_PHRASES)
_WINDOWED_RE = _phrase_regex(_WINDOWED_PHRASES)

# Trigger phrases for the overview_prose trajectory-residue heuristic (PS-5).
# These phrases suggest the author left build-trajectory narration in
# overview_prose where authoritative documentation belongs.
_OVERVIEW_PROSE_RESIDUE_PHRASES = [
    "initially",
    "originally",
    "first attempt",
    "first version",
    "first draft",
    "first pass",
    "we revised",
    "we pivoted",
    "we reverted",
    "after revising",
    "after reviewing",
    "previously considered",
    "scope drift",
    "phase reversion",
]

_OVERVIEW_PROSE_RESIDUE_RE = re.compile(
    r"\b(" + "|".join(re.escape(p) for p in _OVERVIEW_PROSE_RESIDUE_PHRASES) + r")\b",
    re.IGNORECASE,
)

# Section headings that the time-window heuristic is allowed to scan.
# Other sections (## Examples, ## Boundary, ## Failure modes, etc.) are excluded
# because authoring conventions place situational prose there that often contains
# trigger phrases without indicating actual time_window semantics.
_HEURISTIC_BODY_SECTIONS = ("Definition", "Extraction guidance")
_SECTION_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)


def _extract_heuristic_body(body: str) -> str:
    """Return only the content of ## Definition + ## Extraction guidance sections.

    Splits the body at level-2 headings (^## ...$) and keeps blocks whose heading
    text matches one of the allowed section names (case-sensitive on the canonical
    headings). Content before the first ## heading is also dropped (intro prose
    is not a permitted scanning surface).
    """
    if not body:
        return ""
    matches = list(_SECTION_HEADING_RE.finditer(body))
    if not matches:
        return ""
    kept: list[str] = []
    for i, m in enumerate(matches):
        heading = m.group(1).strip()
        # Section runs from end-of-this-heading-line to start-of-next-heading
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        if heading in _HEURISTIC_BODY_SECTIONS:
            kept.append(body[start:end])
    return "\n".join(kept)


# Reserved tokens used by the derivation DSL or by is_applicable_when expressions.
# Identifiers matching these names are NOT field references.
_RESERVED_TOKENS = frozenset({
    "if", "then", "else", "and", "or", "not", "true", "false", "null", "in",
    # JSON Schema-style boolean literals encountered in YAML
    "yes", "no",  # common enum values; never field_ids by convention (kebab-case enums use these)
})

# Match identifier tokens NOT inside double or single quoted strings.
# We do this in two passes: first strip quoted strings, then tokenize what remains.
_QUOTED_STRING_RE = re.compile(r'"[^"]*"|\'[^\']*\'')
_IDENT_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')


@dataclass(frozen=True)
class _ExpressionField:
    """Registers a frontmatter location whose value is a DSL expression
    that may reference field_ids declared elsewhere in the package.

    Adding a new expression-shaped frontmatter key (e.g. a future
    'prerequisite' block) is one entry in _EXPRESSION_FIELDS.
    """
    name: str  # human label used in diagnostics, e.g. "derivation.expr"
    extract: Callable[[dict], Optional[str]]  # returns expr or None given the parsed frontmatter dict


_EXPRESSION_FIELDS: list[_ExpressionField] = [
    _ExpressionField(
        name="is_applicable_when",
        extract=lambda fm: fm.get("is_applicable_when") if isinstance(fm.get("is_applicable_when"), str) else None,
    ),
    _ExpressionField(
        name="derivation.expr",
        extract=lambda fm: (
            fm.get("derivation", {}).get("expr")
            if isinstance(fm.get("derivation"), dict) and isinstance(fm.get("derivation", {}).get("expr"), str)
            else None
        ),
    ),
]


def _ok_from_diagnostics(diagnostics: list[dict]) -> bool:
    """ok flips False only when at least one diagnostic has level='error'."""
    return not any(d.get("level") == "error" for d in diagnostics)


def _extract_field_references(expr: str) -> set[str]:
    """Return the set of identifier tokens in ``expr`` that look like field_id references.

    Strips quoted string literals first (so 'yes', 'confirmed', etc. don't show up).
    Then tokenizes the remainder and filters out reserved keywords and pure-digit
    tokens.
    """
    if not expr:
        return set()
    stripped = _QUOTED_STRING_RE.sub(" ", expr)
    candidates = set(_IDENT_RE.findall(stripped))
    return {c for c in candidates if c.lower() not in _RESERVED_TOKENS}


def validate_package(
    package_dir: Path | str,
    *,
    meta_override: Optional[Path] = None,
) -> dict:
    """Validate a build-skill output package.

    Returns:
        ``{"ok": True | False, "diagnostics": [{"code": ..., "path": ..., "message": ..., "level": "error" | "warning"}, ...]}``.
        ``ok`` is ``False`` iff at least one diagnostic has ``level == "error"``;
        warnings do not flip ``ok``.
    """
    package_dir = Path(package_dir)
    diagnostics: list[dict] = []

    # 1. meta.yaml
    meta_path = Path(meta_override) if meta_override else package_dir / "meta.yaml"
    if not meta_path.exists():
        diagnostics.append({
            "code": "missing_meta",
            "path": str(meta_path),
            "message": "meta.yaml not found",
            "level": "error",
        })
    else:
        meta = yaml.safe_load(meta_path.read_text()) or {}
        meta_result = validate_task_meta(meta, CONTRACTS)
        if meta_result["status"] != "pass":
            for err in meta_result["errors"]:
                diagnostics.append({
                    "code": "meta_schema_violation",
                    "path": str(meta_path),
                    "message": err,
                    "level": "error",
                })

        # Overview-prose trajectory-residue heuristic (PS-5).
        if meta.get("overview_prose_check") != "skip":
            overview = meta.get("overview_prose", "")
            if isinstance(overview, str):
                m_match = _OVERVIEW_PROSE_RESIDUE_RE.search(overview)
                if m_match:
                    diagnostics.append({
                        "code": "overview_prose_trajectory_residue",
                        "path": str(meta_path),
                        "message": (
                            f"meta.overview_prose contains trajectory-residue phrase "
                            f"{m_match.group(1)!r}; the build trajectory belongs in the "
                            f"builder transcript, not the published rubric. Rewrite the "
                            f"prose to describe the final state only — or set "
                            f"overview_prose_check: skip if the heuristic misfires"
                        ),
                        "level": "warning",
                    })

    # 2. each criterion .md file
    criteria_dir = package_dir / "references" / "criteria"
    if criteria_dir.is_dir():
        for md in sorted(criteria_dir.glob("*.md")):
            text = md.read_text()
            m = _FRONTMATTER_RE.match(text)
            if not m:
                diagnostics.append({
                    "code": "missing_frontmatter",
                    "path": str(md),
                    "message": "criterion file lacks --- fences",
                    "level": "error",
                })
                continue
            fm = yaml.safe_load(m.group(1)) or {}
            body = m.group(2)

            fm_result = validate_criterion_frontmatter(fm, CONTRACTS)
            if fm_result["status"] != "pass":
                for err in fm_result["errors"]:
                    diagnostics.append({
                        "code": "criterion_schema_violation",
                        "path": str(md),
                        "message": err,
                        "level": "error",
                    })

            if _TODO_RE.search(body):
                diagnostics.append({
                    "code": "todo_marker_in_body",
                    "path": str(md),
                    "message": "criterion body contains a # TODO marker; resolve before shipping",
                    "level": "error",
                })

            # Time-window discipline heuristic (PS-3).
            if fm.get("time_window_check") != "skip":
                prompt_text = fm.get("prompt", "") if isinstance(fm.get("prompt"), str) else ""
                haystack = f"{prompt_text}\n{_extract_heuristic_body(body)}"
                has_window = bool(fm.get("time_window"))
                pit_match = _POINT_IN_TIME_RE.search(haystack)
                win_match = _WINDOWED_RE.search(haystack)
                if has_window and pit_match:
                    diagnostics.append({
                        "code": "time_window_likely_unneeded",
                        "path": str(md),
                        "message": (
                            f"criterion has time_window={fm.get('time_window')!r} but prose "
                            f"matches point-in-time phrase {pit_match.group(1)!r}; "
                            f"if the criterion is invariant or only evaluated at the index date, "
                            f"drop the time_window — or set time_window_check: skip if the heuristic misfires"
                        ),
                        "level": "warning",
                    })
                if (not has_window) and win_match:
                    diagnostics.append({
                        "code": "time_window_likely_missing",
                        "path": str(md),
                        "message": (
                            f"criterion has no time_window but prose matches windowed phrase "
                            f"{win_match.group(1)!r}; if this asks about something that happened "
                            f"in a window relative to the index date, declare a time_window — "
                            f"or set time_window_check: skip if the heuristic misfires"
                        ),
                        "level": "warning",
                    })

    # 3. Cross-reference check: ensure derivation.expr and is_applicable_when only
    #    reference field_ids that are declared within the same package.
    declared_field_ids: set[str] = set()
    expressions_to_check: list[tuple[str, str, str]] = []  # (path, source, expr)

    if criteria_dir.is_dir():
        # First pass: collect declared field_ids, expressions to check,
        # and derivation truth tables to evaluate.
        derivation_jobs: list[tuple[str, str, str, list[dict]]] = []
        # tuples of (md_path, field_id, derivation_expr, truth_table_rows)
        derived_without_table: list[tuple[str, str]] = []
        # tuples of (md_path, field_id) — derived criteria with no truth_table
        for md in sorted(criteria_dir.glob("*.md")):
            text = md.read_text()
            m = _FRONTMATTER_RE.match(text)
            if not m:
                continue
            fm = yaml.safe_load(m.group(1)) or {}
            fid = fm.get("field_id")
            if isinstance(fid, str):
                declared_field_ids.add(fid)
            for ef in _EXPRESSION_FIELDS:
                expr = ef.extract(fm)
                if expr is not None:
                    expressions_to_check.append((str(md), ef.name, expr))
            # Truth-table collection
            deriv = fm.get("derivation") or {}
            deriv_expr = deriv.get("expr") if isinstance(deriv, dict) else None
            table = fm.get("derivation_truth_table")
            if fm.get("is_final_output") is True and isinstance(deriv_expr, str):
                if isinstance(table, list) and table:
                    derivation_jobs.append((str(md), fid or "", deriv_expr, table))
                else:
                    derived_without_table.append((str(md), fid or ""))

        # Second pass: check each expression's references
        for md_path, source, expr in expressions_to_check:
            refs = _extract_field_references(expr)
            unknown = sorted(refs - declared_field_ids)
            for ref in unknown:
                diagnostics.append({
                    "code": "unknown_field_reference",
                    "path": md_path,
                    "message": f"{source} references field_id '{ref}' which is not declared in this package",
                    "level": "error",
                })

        # Third pass: evaluate truth tables.
        for md_path, fid, deriv_expr, table in derivation_jobs:
            for idx, row in enumerate(table):
                if not isinstance(row, dict):
                    continue
                inputs = row.get("inputs") or {}
                expected = row.get("expected")
                label = row.get("label", f"row {idx}")
                # Check that all input keys are declared field_ids in this package.
                for input_key in (inputs.keys() if isinstance(inputs, dict) else []):
                    if input_key not in declared_field_ids:
                        diagnostics.append({
                            "code": "unknown_field_reference",
                            "path": md_path,
                            "message": (
                                f"derivation_truth_table.inputs[{idx}] ({label!r}) on "
                                f"field_id '{fid}': references field_id '{input_key}' which is not declared in this package"
                            ),
                            "level": "error",
                        })
                # Evaluate.
                try:
                    actual = _evaluate_derivation(deriv_expr, dict(inputs) if isinstance(inputs, dict) else {})
                except Exception as exc:
                    diagnostics.append({
                        "code": "derivation_eval_error",
                        "path": md_path,
                        "message": (
                            f"derivation_truth_table[{idx}] ({label!r}) on "
                            f"field_id '{fid}': evaluate() raised {type(exc).__name__}: {exc}"
                        ),
                        "level": "error",
                    })
                    continue
                if actual != expected:
                    diagnostics.append({
                        "code": "derivation_truth_table_mismatch",
                        "path": md_path,
                        "message": (
                            f"derivation_truth_table[{idx}] ({label!r}) on "
                            f"field_id '{fid}': expected {expected!r}, got {actual!r}"
                        ),
                        "level": "error",
                    })

        # Fourth pass: warn for derived criteria with no truth table.
        for md_path, fid in derived_without_table:
            diagnostics.append({
                "code": "derivation_no_truth_table",
                "path": md_path,
                "message": (
                    f"derived criterion '{fid}' has no derivation_truth_table; "
                    f"add 3-4 boundary rows so the validator can confirm the derivation matches intent"
                ),
                "level": "warning",
            })

    return {"ok": _ok_from_diagnostics(diagnostics), "diagnostics": diagnostics}
