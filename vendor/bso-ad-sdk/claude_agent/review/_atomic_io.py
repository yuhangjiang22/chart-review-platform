"""Atomic JSONL read-modify-write helper.

The review/adjudication/ontology subsystems all maintain append-only JSONL logs
on disk where each record can later be marked superseded by rewriting the file.
The naive pattern is:

    lines = path.read_text().splitlines()
    # mutate lines...
    path.write_text("\n".join(new_lines) + "\n")

This is racy: two concurrent calls (e.g. two HTTP threads in workbench.py)
can each read the same baseline, each compute a private new state, and the
last writer silently overwrites the first writer's row.

This module provides `atomic_rewrite_jsonl(path, mutate)` which:

  1. Acquires an exclusive fcntl.flock on a per-file lockfile (path + ".lock").
  2. Reads the current JSONL contents (empty list if missing).
  3. Calls `mutate(records: list[dict]) -> list[dict]` to compute the new state.
  4. Writes the new state to a tempfile in the same directory.
  5. fsync's the tempfile, then os.replace(tmp, target) — atomic on POSIX.
  6. Releases the flock.

The lockfile is intentionally separate from the target file so that the
os.replace() at the end doesn't replace the file we hold a lock on.
"""
from __future__ import annotations

import fcntl
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator


@contextmanager
def _flock(lock_path: Path) -> Iterator[None]:
    """Acquire an exclusive advisory lock on `lock_path`. Blocks until granted."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Open in append mode so the file gets created if missing without truncating.
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(json.loads(line))
    return out


def atomic_rewrite_jsonl(
    path: Path,
    mutate: Callable[[list[dict]], list[dict]],
) -> None:
    """Atomically rewrite a JSONL file under an exclusive flock.

    Reads existing JSONL (empty list if missing), passes the parsed list of
    dicts to ``mutate``, then writes back the returned list atomically.

    The mutator returns the FULL new list — it can add, drop, or modify rows.

    On POSIX this is safe under concurrent processes/threads because:
      * the flock serializes the read-modify-write window
      * os.replace() is atomic w.r.t. readers of the target path
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with _flock(lock_path):
        current = _read_jsonl(path)
        new_records = mutate(current)
        # Render the new file body. Trailing newline matches existing pattern.
        body = "\n".join(json.dumps(r, ensure_ascii=False) for r in new_records)
        if new_records:
            body += "\n"
        # Tempfile in the same directory to make os.replace atomic on POSIX.
        fd, tmp_name = tempfile.mkstemp(
            prefix=path.name + ".",
            suffix=".tmp",
            dir=str(path.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(body)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_name, path)
        except BaseException:
            # Clean up tempfile on any failure (don't shadow original error).
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise


def atomic_append_jsonl(path: Path, record: dict) -> None:
    """Append one JSONL record under the same lock used by atomic_rewrite_jsonl.

    Pure POSIX append is roughly atomic for small writes (<= PIPE_BUF), but a
    large pydantic dump can blow past that and interleave with concurrent
    appends. Routing appends through the same lock gives uniform safety.
    """
    def _append(rows: list[dict]) -> list[dict]:
        rows.append(record)
        return rows
    atomic_rewrite_jsonl(path, _append)


def atomic_rewrite_json(
    path: Path,
    mutate: Callable[[dict], dict],
    *,
    indent: int = 2,
) -> None:
    """Atomically rewrite a JSON document under an exclusive flock.

    Variant of ``atomic_rewrite_jsonl`` for files that hold a single JSON
    object (e.g. concepts.json). The mutator gets the parsed dict and must
    return the new dict; the file is then serialized + fsynced + renamed
    under the same per-file lock convention.

    Raises FileNotFoundError if the target doesn't exist — concepts.json is
    expected to exist before any decision is applied.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with _flock(lock_path):
        if not path.exists():
            raise FileNotFoundError(f"{path} does not exist; refusing to create")
        current = json.loads(path.read_text(encoding="utf-8"))
        new_doc = mutate(current)
        body = json.dumps(new_doc, ensure_ascii=False, indent=indent) + "\n"
        fd, tmp_name = tempfile.mkstemp(
            prefix=path.name + ".",
            suffix=".tmp",
            dir=str(path.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(body)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_name, path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
