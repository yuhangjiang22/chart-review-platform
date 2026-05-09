"""Cross-criterion alert detectors run against a ReviewRecord + CompiledTask.

For MVP, two detectors:
- derivation_input_missing: a derived field has at least one input answered `no_info`
- ambiguous_low_confidence_majority: ≥50% of leaves are low-confidence (signals
  protocol-level ambiguity, not a single-criterion issue)
"""

from __future__ import annotations

from typing import Any

from .derivation import derived_field_inputs


def detect_alerts(
    compiled_task: dict[str, Any],
    record: dict[str, Any],
) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []

    fields = compiled_task["fields"]
    by_id = {f["id"]: f for f in fields}
    answers = {a["field_id"]: a for a in record.get("criterion_assessments", [])}
    all_field_ids = [f["id"] for f in fields]

    # Detector 1: derivation_input_missing
    for f in fields:
        if "derivation" not in f:
            continue
        inputs = derived_field_inputs(f["derivation"], all_field_ids)
        missing = [
            i for i in inputs
            if i in answers and answers[i].get("answer") in ("no_info", None)
        ]
        if missing:
            alerts.append({
                "fields": [f["id"]] + missing,
                "description": (
                    f"Derived field `{f['id']}` has input(s) answered `no_info`: "
                    f"{', '.join(missing)}. Result may be unreliable."
                ),
                "severity": "warning",
            })

    # Detector 2: ambiguous_low_confidence_majority
    leaf_assessments = [
        a for a in record.get("criterion_assessments", [])
        if "derivation" not in by_id.get(a["field_id"], {})
    ]
    if leaf_assessments:
        low = sum(1 for a in leaf_assessments if a.get("confidence") == "low")
        if low / len(leaf_assessments) >= 0.5:
            alerts.append({
                "fields": [a["field_id"] for a in leaf_assessments if a.get("confidence") == "low"],
                "description": (
                    f"{low}/{len(leaf_assessments)} leaf criteria are low-confidence. "
                    "Consider reviewing the protocol for ambiguity, not just individual answers."
                ),
                "severity": "warning",
            })

    return alerts
