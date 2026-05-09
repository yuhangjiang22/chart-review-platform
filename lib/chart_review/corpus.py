"""Filesystem-as-API helpers for the synthetic patient corpus.

Each patient is a directory under <corpus_root>/patients/<patient_id>/.
The agent's tool surface is bash (grep, cat, jq) — these helpers exist so
the platform's Python code (CLI, batch runner, validation tests, the
synthetic agent adapter) can talk to the same corpus without re-shelling.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Iterator


def _patients_dir(corpus_root: Path) -> Path:
    return Path(corpus_root) / "patients"


def iter_patients(corpus_root: Path) -> Iterator[dict[str, Any]]:
    """Yield {'patient_id', 'path'} for each patient directory, sorted.

    Returns an empty iterator if the corpus root has no patients/ subdirectory.
    """
    pdir = _patients_dir(corpus_root)
    if not pdir.exists():
        return
    for d in sorted(pdir.iterdir()):
        if d.is_dir() and d.name.startswith("patient_"):
            yield {"patient_id": d.name, "path": d}


def load_meta(corpus_root: Path, patient_id: str) -> dict[str, Any]:
    """Return the parsed meta.json for the given patient."""
    return json.loads((_patients_dir(corpus_root) / patient_id / "meta.json").read_text())


def load_ground_truth(corpus_root: Path, patient_id: str) -> dict[str, Any]:
    """Return the parsed ground_truth.json for the given patient."""
    return json.loads((_patients_dir(corpus_root) / patient_id / "ground_truth.json").read_text())


def read_note(corpus_root: Path, patient_id: str, note_filename: str) -> str:
    """Return the full text of a single note file."""
    return (_patients_dir(corpus_root) / patient_id / "notes" / note_filename).read_text()


def grep_notes(corpus_root: Path, patient_id: str, pattern: str) -> list[dict[str, Any]]:
    """Run `grep -n <pattern>` against the patient's notes/. Returns one entry
    per match: {'note_filename', 'line_number', 'line'}."""
    notes_dir = _patients_dir(corpus_root) / patient_id / "notes"
    if not notes_dir.exists():
        return []
    proc = subprocess.run(
        ["grep", "-n", "-E", pattern, "-r", str(notes_dir)],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode not in (0, 1):
        raise RuntimeError(f"grep failed (code {proc.returncode}): {proc.stderr}")
    out = []
    for raw in proc.stdout.splitlines():
        # Format: <path>:<line_number>:<line_content>
            # NOTE: paths containing literal colons would cause silent match
            # drops here. Safe for the synthetic corpus (filename schema is
            # YYYY-MM-DD__<doc_type>.txt — no colons), but if this helper is
            # ever reused against arbitrary paths, switch to grep --null (-Z)
            # and parse on \0 instead.
        m = re.match(r"^(?P<path>[^:]+):(?P<n>\d+):(?P<line>.*)$", raw)
        if not m:
            continue
        out.append({
            "note_filename": Path(m.group("path")).name,
            "line_number": int(m.group("n")),
            "line": m.group("line"),
        })
    return out


def omop_query(
    corpus_root: Path,
    patient_id: str,
    table: str,
    predicate: dict[str, Any],
) -> list[dict[str, Any]]:
    """Read the patient's OMOP `<table>.json` and filter by predicate.

    Predicate keys:
      - exact field name → exact match
      - <field>_prefix → string startswith
      - <field>_in → membership
    """
    path = _patients_dir(corpus_root) / patient_id / "omop" / f"{table}.json"
    if not path.exists():
        return []
    rows = json.loads(path.read_text())
    out = []
    for row in rows:
        if _row_matches(row, predicate):
            out.append(row)
    return out


def _row_matches(row: dict[str, Any], predicate: dict[str, Any]) -> bool:
    for key, want in predicate.items():
        if key.endswith("_prefix"):
            field = key[: -len("_prefix")]
            if not str(row.get(field, "")).startswith(want):
                return False
        elif key.endswith("_in"):
            field = key[: -len("_in")]
            if row.get(field) not in want:
                return False
        else:
            if row.get(key) != want:
                return False
    return True
