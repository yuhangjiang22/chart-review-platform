#!/usr/bin/env python3
"""Write the final NER JSON for one record (keyed by note_id).

Invoked by the ner skill via Bash so the agent doesn't have to write inline
Python for the write step. The MCP server stays focused on ontology lookups;
this script owns the file-I/O side (sanitize filename, ensure output dir,
write the JSON record).

Usage:
    python3 .claude/skills/bso-ad/scripts/write_ner.py \\
        --note-id note_17885 \\
        --person-id pt_001 \\
        --model claude-sonnet-4-6 \\
        --entities-json '[{"text":"social isolation","start":38,"end":54,
                           "entity_type":"Element_Relevant_to_Social_and_Community_Context",
                           "concept_name":"Social_Isolation",
                           "status":"mapped"}]'

Writes to:
    {output_root}/{note_id}.json

`output_root` defaults to `results/ner` (relative to cwd). The note_id
component is sanitized — any character outside [A-Za-z0-9._-] becomes `-`.
Calling again with the same args **overwrites** the file.

The body is one JSON object:
    {"note_id": "...", "person_id": "...", "model": "...",
     "entities": [...], "skill_version": "..."}

Required entity keys: text, start, end, entity_type, concept_name, status.
status must be one of: "mapped", "novel_candidate".

Prints one JSON summary line on success:
    {"path": "...", "n_entities": N, "n_mapped": M, "n_novel": K,
     "bytes_written": B}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPT_DIR.parents[3]
_SKILL_DIR = _SCRIPT_DIR.parent
_spec = spec_from_file_location(
    "_skill_version",
    _PROJECT_ROOT / ".claude" / "skills" / "_shared" / "skill_version.py",
)
_skill_version_mod = module_from_spec(_spec)
_spec.loader.exec_module(_skill_version_mod)
read_skill_version = _skill_version_mod.read_skill_version

_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]")
_ALLOWED_STATUSES = {"mapped", "mapped_uncertain", "novel_candidate"}
_ALLOWED_MATCH_KINDS = {
    "mapped_exact", "mapped_case_normalized", "mapped_underscore_normalized",
    "mapped_uncertain_alternatives_pick", "mapped_uncertain_parent_fallback",
    "mapped_uncertain_navigated",
    "novel_candidate_none",
}
_REQUIRED_ENTITY_KEYS = ("text", "start", "end", "entity_type", "concept_name", "status", "match_kind")

# match_kind → status derivation; single source of truth, mirrors
# claude_agent.review.schema.derive_status. Each match_kind value is named
# `<status>_<detail>` so the mapping is visible in the strings themselves.
_MATCH_KIND_TO_STATUS = {
    "mapped_exact": "mapped",
    "mapped_case_normalized": "mapped",
    "mapped_underscore_normalized": "mapped",
    "mapped_uncertain_alternatives_pick": "mapped_uncertain",
    "mapped_uncertain_parent_fallback": "mapped_uncertain",
    "mapped_uncertain_navigated": "mapped_uncertain",
    "novel_candidate_none": "novel_candidate",
}


def _sanitize(value: str) -> str:
    return _FILENAME_SAFE_RE.sub("-", value)


def _validate_entities(entities: list, source_text: str | None = None) -> list:
    """Validate the agent-supplied entity list.

    Required keys: text / start / end / entity_type / concept_name / status / match_kind.
    Optional: anchor (the substring used by `locate_in_source` to disambiguate;
    we keep it on the output for audit/debug trace, but its presence isn't
    required for backwards compat with older skill versions).

    When `source_text` is provided we additionally enforce that
    ``source_text[start:end] == text`` for every entity. This catches the
    case where the agent skipped `locate_in_source` and hand-rolled offsets;
    a mismatch is treated as a hard schema violation rather than silently
    written, so downstream visualization / evaluation never sees a wrong
    offset. Pass `None` to skip this check (used by tests and by callers
    that don't have the source text on hand).
    """
    if not isinstance(entities, list):
        raise ValueError("--entities-json must decode to a list of objects")
    cleaned: list = []
    for i, ent in enumerate(entities):
        if not isinstance(ent, dict):
            raise ValueError(f"entities[{i}] is not an object")
        missing = [k for k in _REQUIRED_ENTITY_KEYS if k not in ent]
        if missing:
            raise ValueError(f"entities[{i}] missing keys: {missing}")
        status = ent["status"]
        if status not in _ALLOWED_STATUSES:
            raise ValueError(
                f"entities[{i}].status={status!r} not in {sorted(_ALLOWED_STATUSES)}"
            )
        mk = ent.get("match_kind")
        if mk not in _ALLOWED_MATCH_KINDS:
            raise ValueError(
                f"entities[{i}].match_kind={mk!r} not in {sorted(_ALLOWED_MATCH_KINDS)}"
            )
        expected_status = _MATCH_KIND_TO_STATUS[mk]
        if status != expected_status:
            raise ValueError(
                f"entities[{i}].status={status!r} inconsistent with match_kind={mk!r}; "
                f"expected status={expected_status!r}"
            )
        # Cross-field consistency between (status, concept_name):
        #   - novel_candidate ⇒ concept_name should be empty (no ontology label
        #     because, by definition, no ontology concept fit)
        #   - mapped / mapped_uncertain ⇒ concept_name must be non-empty
        #
        # Agents sometimes emit `status=novel_candidate` together with a
        # non-empty `concept_name` (the agent had a candidate in mind but
        # hedged with the novel status). Rejecting this outright would cause
        # the agent to drop the candidate on retry — discarding useful
        # information. Instead, AUTO-PROMOTE to mapped_uncertain so the
        # candidate is preserved. The warning surfaces the issue so the agent
        # can learn to commit explicitly next time.
        #
        # The inverse case (mapped / mapped_uncertain with empty concept_name)
        # has nothing to salvage — reject it as a hard schema violation.
        concept_name_str = str(ent.get("concept_name") or "")
        if status == "novel_candidate" and concept_name_str.strip() not in ("", "None"):
            print(
                f"[warn] entities[{i}]: status='novel_candidate' with non-empty "
                f"concept_name={concept_name_str!r} — auto-promoting to "
                f"status='mapped_uncertain' / match_kind='mapped_uncertain_alternatives_pick' "
                f"to preserve the agent's candidate. Agent should commit to "
                f"mapped_uncertain explicitly next time (see SKILL.md Step 3).",
                file=sys.stderr,
            )
            status = "mapped_uncertain"
            mk = "mapped_uncertain_alternatives_pick"
        elif status in ("mapped", "mapped_uncertain") and concept_name_str.strip() == "":
            raise ValueError(
                f"entities[{i}] schema violation: "
                f"status={status!r} requires a non-empty concept_name. "
                f"If no concept fits, use status='novel_candidate' with "
                f"match_kind='novel_candidate_none' and concept_name=''."
            )
        # Coerce ints; surface clear errors when the agent sends strings.
        try:
            start = int(ent["start"])
            end = int(ent["end"])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"entities[{i}] start/end must be integers ({exc})") from exc
        text = str(ent["text"])

        # Offset consistency check — the LLM's char arithmetic is unreliable,
        # so we cross-check against the actual source bytes when available.
        if source_text is not None:
            if start < 0 or end > len(source_text) or start > end:
                raise ValueError(
                    f"entities[{i}] offsets out of range: start={start} end={end} "
                    f"source_len={len(source_text)}"
                )
            actual = source_text[start:end]
            if actual != text:
                raise ValueError(
                    f"entities[{i}] offset/text mismatch:\n"
                    f"  source[{start}:{end}] = {actual!r}\n"
                    f"  but text             = {text!r}\n"
                    f"Use `locate_in_source(anchor, text)` to get authoritative "
                    f"offsets — never compute them by inspection."
                )

        out: dict = {
            "text": text,
            "start": start,
            "end": end,
            "entity_type": str(ent["entity_type"]),
            "concept_name": str(ent["concept_name"]),
            "status": status,
            "match_kind": mk,
        }
        # Preserve anchor for audit/debug trace if the agent provided it.
        if "anchor" in ent and ent["anchor"] is not None:
            out["anchor"] = str(ent["anchor"])
        cleaned.append(out)
    return cleaned


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="write_ner",
        description="Write the final NER JSON for one record.",
    )
    parser.add_argument("--note-id", required=True, help="Note identifier from the prompt")
    parser.add_argument(
        "--person-id", default=None,
        help="Optional patient/person identifier associated with this note",
    )
    parser.add_argument(
        "--model", required=True,
        help="Your actual model identifier, e.g. claude-sonnet-4-6",
    )
    parser.add_argument(
        "--entities-json", required=True,
        help="JSON-encoded list of entity objects (see module docstring)",
    )
    parser.add_argument(
        "--output-root", default="results/ner",
        help="Output directory (default: results/ner, relative to cwd)",
    )
    parser.add_argument(
        "--source-text-file", default=None,
        help="Path to the source text file the agent annotated. When supplied "
             "(the runner pins it via SKILL.md), each entity's offsets are "
             "validated as `source[start:end] == text`. Mismatches are hard "
             "errors so wrong offsets never reach disk. Optional for backward "
             "compat with older callers, but the runner always sets it.",
    )
    parser.add_argument(
        "--ontology-version",
        default=None,
        help="Stamp this ontology version on the output. "
             "Read from concepts.json _meta.version by the runner; the agent CLI "
             "invocation just passes it through.",
    )
    args = parser.parse_args()

    try:
        entities_raw = json.loads(args.entities_json)
    except json.JSONDecodeError as exc:
        parser.error(f"--entities-json is not valid JSON: {exc}")

    source_text: str | None = None
    if args.source_text_file:
        src_path = Path(args.source_text_file).expanduser()
        if not src_path.is_file():
            parser.error(
                f"--source-text-file does not exist: {src_path}. The runner "
                f"normally writes this scratch file; if you're invoking write_ner "
                f"directly, point it at the _intermediate/.source_<note_id>.txt "
                f"file in the output dir or omit the flag to skip offset validation."
            )
        source_text = src_path.read_text(encoding="utf-8")

    try:
        entities = _validate_entities(entities_raw, source_text=source_text)
    except ValueError as exc:
        parser.error(str(exc))

    filename = f"{_sanitize(args.note_id)}.json"
    out_path = Path(args.output_root) / filename
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
    except PermissionError as exc:
        parser.error(
            f"Cannot create output directory {out_path.parent}: {exc}. "
            f"Pass --output-root=<writable path> — use whatever directory "
            f"the caller specified in the invocation (e.g. /io/slot1)."
        )

    skill_version = read_skill_version(_SKILL_DIR / "SKILL.md")
    payload = {
        "note_id": args.note_id,
        "person_id": args.person_id,
        "model": args.model,
        "entities": entities,
        "skill_version": skill_version,
        "ontology_version": args.ontology_version or "unknown",
    }
    data = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    out_path.write_text(data, encoding="utf-8")

    n_mapped = sum(1 for e in entities if e["status"] == "mapped")
    n_novel = sum(1 for e in entities if e["status"] == "novel_candidate")
    summary = {
        "path": str(out_path),
        "n_entities": len(entities),
        "n_mapped": n_mapped,
        "n_novel": n_novel,
        "bytes_written": len(data.encode()),
    }
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
