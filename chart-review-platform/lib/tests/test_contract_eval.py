"""Cross-language parity: every TS safeEval result must match Python.

Python entry point: chart_review.derivation.evaluate(expr, env) -> Any
TypeScript entry:  app/server/contract-eval.ts :: safeEval(expr, env) -> unknown

The dump script (app/scripts/dump-eval-results.mjs) runs safeEval for each
corpus entry and writes app/scripts/eval-parity-results.json.  This test
re-runs that dump for freshness, then compares each TS result against the
Python evaluate() result and the declared expected value.

Python is the reference implementation; if there is a divergence the TS port
must be fixed, not Python.
"""

from __future__ import annotations

import json
import subprocess
import pathlib
from typing import Any

from chart_review.derivation import evaluate  # noqa: F401  (the Python reference)

REPO = pathlib.Path(__file__).resolve().parents[3]
APP_DIR = REPO / "chart-review-platform" / "app"
RESULTS_FILE = APP_DIR / "scripts" / "eval-parity-results.json"


def _py_eval(expr: str, env: dict[str, Any]) -> Any:
    """Thin wrapper that mirrors safeEval's null-on-error contract.

    safeEval returns null when the expression raises; Python evaluate() raises.
    For parity we catch exceptions and return None (JSON null), matching TS.
    Missing identifiers in Python raise NameError — same as safeEval returning
    null/undefined for an absent key, so we map that to None too.
    """
    try:
        return evaluate(expr, env)
    except Exception:
        return None


def test_ts_python_parity():
    """Re-dump TS results fresh, then compare each result against Python."""
    # 1. Regenerate TS results so the file always reflects the current source.
    subprocess.run(
        ["npx", "tsx", "scripts/dump-eval-results.mjs"],
        cwd=str(APP_DIR),
        check=True,
        capture_output=True,
        text=True,
    )

    results = json.loads(RESULTS_FILE.read_text())
    failures: list[dict] = []

    for r in results:
        py = _py_eval(r["expr"], r["env"])
        ts = r["ts_result"]
        exp = r["expected"]

        # Both implementations must agree with each other AND with expected.
        if py != ts or py != exp:
            failures.append(
                {
                    "expr": r["expr"],
                    "env": r["env"],
                    "expected": exp,
                    "py": py,
                    "ts": ts,
                }
            )

    assert not failures, (
        f"{len(failures)} parity failure(s):\n"
        + json.dumps(failures, indent=2)
    )
