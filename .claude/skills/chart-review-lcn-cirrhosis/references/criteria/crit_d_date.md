---
field_id: crit_d_date
prompt: Date of the qualifying blood biomarker (FIB-4 >2.67 or platelets <150)
answer_schema:
  type: string
cardinality: one
group: step1_criteria
---

# Criterion: crit_d_date (evidence date)

## Definition
The lab date of the earliest measurement satisfying criterion D. Blank when crit_d_biomarker is not_met.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.

ABSENT VALUE: when no qualifying evidence exists, commit **null** (JSON null / unanswered) — never the strings "none", "no_info", or "unknown". Downstream date parsing treats only null/ISO dates as valid.
