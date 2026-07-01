"""Per-case JSONL event log for NER runs.

One log file per agent invocation, written as a sidecar next to the result
JSON the agent produces. Each line is a self-contained JSON object — the
file can be tail-followed during a long run, partial-read on crash, or
analyzed wholesale with `jq`.

Common fields (note_id, person_id, model) are set once at construction and merged
into every emitted event. Per-event fields are passed via kwargs and override
common keys when names collide.

Atomicity: each emit() appends one line and flushes. If the process dies
mid-run the partial log is still readable up to the last completed line.

Usage:
    with EventLog(path, common={"note_id": "...", "person_id": "...", "model": "..."}) as log:
        log.emit("run_start", max_turns=200, max_budget_usd=5.0)
        log.emit("tool_call", turn=1, tool_name="...", input_preview="...")
        log.emit("run_end", turns=10, duration_ms=14424, ...)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, IO, Optional


def _now_iso_ms_z() -> str:
    """ISO 8601 UTC with millisecond precision, e.g. 2026-05-07T22:55:01.123Z."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


@dataclass
class EventLog:
    """Append-only JSONL event log with merged common fields.

    Use as a context manager so __exit__ closes the file. Reusing an existing
    path appends. Calling emit() outside the with-block raises RuntimeError.
    """

    path: Path
    common: dict[str, Any] = field(default_factory=dict)
    _file: Optional[IO[str]] = None

    def __enter__(self) -> "EventLog":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = open(self.path, "a", encoding="utf-8")
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None

    def emit(self, event: str, **fields: Any) -> None:
        """Write one JSON line. Per-event kwargs override common fields."""
        if self._file is None:
            raise RuntimeError(
                "EventLog.emit() called outside `with` block — "
                "construct EventLog as a context manager."
            )
        record = {"ts": _now_iso_ms_z(), "event": event, **self.common, **fields}
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        self._file.write(line + "\n")
        self._file.flush()
