---
field_id: shunt_date
prompt: Date of the TIPS / BRTO / porto-systemic shunt procedure, if any
answer_schema:
  type: string
cardinality: one
group: severity
---

# Criterion: shunt_date (evidence date)

## Definition
The procedure date of the earliest TIPS / BRTO / porto-systemic shunt surgery at ANY time ANYWHERE in the chart — before OR AFTER index. Blank only when no such procedure is documented anywhere.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.

ABSENT VALUE: when no qualifying evidence exists, commit **null** (JSON null / unanswered) — never the strings "none", "no_info", or "unknown". Downstream date parsing treats only null/ISO dates as valid.
