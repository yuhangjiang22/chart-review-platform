---
field_id: biopsy_cirrhosis_date
prompt: Date of the cirrhotic liver biopsy (METAVIR 4 / Ishak 5-6), if any
answer_schema:
  type: string
cardinality: one
group: step1
---

## FORWARD-SCAN SEMANTICS (v0.4 — read this FIRST)
Commit the date of the **EARLIEST qualifying evidence ANYWHERE in the chart**
— IGNORE every lookback window when answering this date field. Windows are
applied downstream by the outcome scanner at each candidate date; your job is
only to date the evidence. Evidence BEFORE or AFTER the index date both count.
If several qualify, the EARLIEST wins. Null only when no qualifying evidence
exists anywhere.


# Criterion: biopsy_cirrhosis_date (evidence date)

## Definition
The date of ANY liver biopsy demonstrating METAVIR 4 / Ishak 5-6, regardless of how old — whether it currently counts as the recent-biopsy rule or as criterion E is relative to the candidate date and is computed by the scanner. Blank when no cirrhotic biopsy exists.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.

ABSENT VALUE: when no qualifying evidence exists, commit **null** (JSON null / unanswered) — never the strings "none", "no_info", or "unknown". Downstream date parsing treats only null/ISO dates as valid.
