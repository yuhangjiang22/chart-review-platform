---
field_id: ascites_date
prompt: Date of the most recent documented ascites/hydrothorax decompensation event, if any
answer_schema:
  type: string
cardinality: one
group: decompensation
---

# Criterion: ascites_date (evidence date)

## Definition
The date of the MOST RECENT documented ascites/hydrothorax decompensation event at ANY time up to the index date — record it even when the event is OLDER than 365 days (in that case ascites_365d is still `none`). Blank when no such event is documented at all.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.
