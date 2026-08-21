---
field_id: phg_bleed_date
prompt: Date of the most recent documented PHG bleeding event, if any
answer_schema:
  type: string
cardinality: one
group: decompensation
---

# Criterion: phg_bleed_date (evidence date)

## Definition
The date of the MOST RECENT documented portal-hypertensive-gastropathy bleeding at ANY time up to index — record even when older than 365 days. Blank when never documented.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.

ABSENT VALUE: when no qualifying evidence exists, commit **null** (JSON null / unanswered) — never the strings "none", "no_info", or "unknown". Downstream date parsing treats only null/ISO dates as valid.
