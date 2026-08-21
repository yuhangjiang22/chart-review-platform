---
field_id: biopsy_cirrhosis_date
prompt: Date of the cirrhotic liver biopsy (METAVIR 4 / Ishak 5-6), if any
answer_schema:
  type: string
cardinality: one
group: step1
---

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
