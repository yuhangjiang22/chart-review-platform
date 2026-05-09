"""Validate CompiledTask and ReviewRecord dicts against the canonical schemas.

Uses jsonschema with a referencing.Registry so cross-file `$ref`s resolve.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource


def _load_schemas(contracts_dir: Path) -> Registry:
    registry = Registry()
    for name in (
        "evidence.schema.json",
        "trace.schema.json",
        "compiled_task.schema.json",
        "review_record.schema.json",
        "review_state.schema.json",
    ):
        path = contracts_dir / name
        if not path.exists():
            raise FileNotFoundError(f"Missing schema: {path}")
        schema = json.loads(path.read_text())
        # Register both by $id and by filename so relative refs ("evidence.schema.json") resolve.
        resource = Resource.from_contents(schema)
        registry = registry.with_resources([
            (schema["$id"], resource),
            (name, resource),
        ])
    return registry


def _validator(contracts_dir: Path, root_name: str) -> Draft202012Validator:
    registry = _load_schemas(contracts_dir)
    schema_path = contracts_dir / root_name
    schema = json.loads(schema_path.read_text())
    return Draft202012Validator(schema, registry=registry)


def validate_compiled_task(
    compiled: dict[str, Any],
    contracts_dir: Path,
) -> dict[str, Any]:
    v = _validator(contracts_dir, "compiled_task.schema.json")
    errors = sorted(v.iter_errors(compiled), key=lambda e: list(e.path))
    return {
        "status": "pass" if not errors else "fail",
        "errors": [_format_error(e) for e in errors],
    }


def validate_review_record(
    record: dict[str, Any],
    contracts_dir: Path,
) -> dict[str, Any]:
    v = _validator(contracts_dir, "review_record.schema.json")
    errors = sorted(v.iter_errors(record), key=lambda e: list(e.path))
    return {
        "status": "pass" if not errors else "fail",
        "errors": [_format_error(e) for e in errors],
    }


def validate_review_state(
    state: dict[str, Any],
    contracts_dir: Path,
) -> dict[str, Any]:
    v = _validator(contracts_dir, "review_state.schema.json")
    errors = sorted(v.iter_errors(state), key=lambda e: list(e.path))
    return {
        "status": "pass" if not errors else "fail",
        "errors": [_format_error(e) for e in errors],
    }


def _format_error(err) -> str:
    path = "/".join(str(p) for p in err.absolute_path) or "<root>"
    return f"{path}: {err.message}"


def validate_task_meta(meta: dict, contracts_dir: Path | str) -> dict:
    """Validate a parsed meta.yaml against contracts/task-meta.schema.json.

    Returns {"status": "pass"} or {"status": "fail", "errors": [str, ...]}.
    """
    contracts_dir = Path(contracts_dir)
    v = _validator(contracts_dir, "task-meta.schema.json")
    errors = sorted(v.iter_errors(meta), key=lambda e: list(e.path))
    return {
        "status": "pass" if not errors else "fail",
        "errors": [_format_error(e) for e in errors],
    }


def validate_criterion_frontmatter(fm: dict, contracts_dir: Path | str) -> dict:
    """Validate criterion .md frontmatter against contracts/criterion-file.schema.json."""
    contracts_dir = Path(contracts_dir)
    v = _validator(contracts_dir, "criterion-file.schema.json")
    errors = sorted(v.iter_errors(fm), key=lambda e: list(e.path))
    return {
        "status": "pass" if not errors else "fail",
        "errors": [_format_error(e) for e in errors],
    }
