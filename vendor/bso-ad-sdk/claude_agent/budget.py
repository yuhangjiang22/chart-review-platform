"""Cross-invocation cumulative budget tracking for batch runs.

Each `run_agent` call has its own per-session ``max_budget_usd`` cap, but
nothing stops a 1000-case shell loop from blowing through $200 silently
($0.20/case × 1000). This module keeps a small JSON state file in the
output dir and refuses to start a run when running it would push the
cumulative total over a configured ceiling.

State file layout::

    {
      "total_cost_usd": 12.34,
      "runs": 56,
      "first_run_at": "2026-05-08T03:14:15Z",
      "last_run_at":  "2026-05-08T07:42:01Z"
    }

Concurrency: assumes a single writer per output dir. Concurrent batches
into the same dir will race and may double-count or under-count — document
this and don't fan out parallel writers without a separate lock layer.

Robustness: if the state file is corrupt or unreadable, the guard logs a
warning and falls back to $0 used (fail-open on read). Writes are atomic
(``write tmp → fsync → rename``) so a crash mid-write can't corrupt the
file we'll read on the next invocation.

Cost source: we record ``cost_usd_estimated`` from the local pricing table
(see :mod:`pricing`). The Azure / OpenAI bill arrives days later and is
unsuitable for a same-process budget gate. Estimates differ from billed
amounts when caching changes hit ratios — keep that in mind when sizing
the ceiling.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger("claude_agent_framework")


@dataclass(slots=True)
class BudgetState:
    total_cost_usd: float = 0.0
    runs: int = 0
    first_run_at: Optional[str] = None
    last_run_at: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "total_cost_usd": round(self.total_cost_usd, 6),
            "runs": self.runs,
            "first_run_at": self.first_run_at,
            "last_run_at": self.last_run_at,
        }


class BudgetExceeded(RuntimeError):
    """Raised by BudgetGuard.check_or_raise when this run would exceed cap."""


class BudgetGuard:
    """File-backed cumulative budget tracker."""

    def __init__(self, state_file: Path, total_budget_usd: float) -> None:
        self.state_file = state_file
        self.total_budget_usd = total_budget_usd

    def _read(self) -> BudgetState:
        if not self.state_file.is_file():
            return BudgetState()
        try:
            raw = json.loads(self.state_file.read_text(encoding="utf-8"))
            return BudgetState(
                total_cost_usd=float(raw.get("total_cost_usd", 0.0)),
                runs=int(raw.get("runs", 0)),
                first_run_at=raw.get("first_run_at"),
                last_run_at=raw.get("last_run_at"),
            )
        except (OSError, json.JSONDecodeError, ValueError, TypeError) as exc:
            logger.warning(
                "Budget state file %s unreadable (%s) — treating as $0 used. "
                "Delete or repair manually if this is wrong.",
                self.state_file, exc,
            )
            return BudgetState()

    def _write_atomic(self, state: BudgetState) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(self.state_file.suffix + ".tmp")
        payload = json.dumps(state.to_dict(), ensure_ascii=False, indent=2) + "\n"
        with tmp.open("w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.state_file)

    def check_or_raise(self, this_run_max_usd: float) -> BudgetState:
        """Return current state if `total + this_run_max_usd <= total_budget`,
        else raise BudgetExceeded.

        Uses the per-run cap (not the actual cost, which we don't know yet)
        so we never overshoot the ceiling even on a worst-case run.
        """
        state = self._read()
        if state.total_cost_usd + this_run_max_usd > self.total_budget_usd:
            raise BudgetExceeded(
                f"Cumulative budget would be exceeded.\n"
                f"  used so far:    ${state.total_cost_usd:.4f} ({state.runs} runs)\n"
                f"  this run cap:   ${this_run_max_usd:.4f}\n"
                f"  total budget:   ${self.total_budget_usd:.4f}\n"
                f"  state file:     {self.state_file}\n"
                f"To continue, raise --total-budget, lower --max-budget, or "
                f"reset by deleting the state file."
            )
        return state

    def record(self, run_cost_usd: float) -> BudgetState:
        """Add this run's actual estimated cost to the cumulative state.

        Idempotency note: callers must invoke this exactly once per
        successful run. We don't dedupe by session_id — too easy to get
        wrong if the SDK changes how IDs are generated.
        """
        state = self._read()
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        state.total_cost_usd += max(0.0, float(run_cost_usd or 0.0))
        state.runs += 1
        if state.first_run_at is None:
            state.first_run_at = now
        state.last_run_at = now
        self._write_atomic(state)
        return state

    @staticmethod
    def default_state_file_for(output_root: Path) -> Path:
        return output_root / ".budget_state.json"
