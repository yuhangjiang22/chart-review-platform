---
field_id: ohe_date
prompt: Date of the most recent documented overt-HE event, if any
answer_schema:
  type: string
cardinality: one
group: decompensation
---

# Criterion: ohe_date (evidence date)

## Definition
The date of the MOST RECENT documented overt hepatic encephalopathy event at ANY time up to index — record even when older than 365 days (ohe_365d stays `none` then). Blank when never documented.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.
