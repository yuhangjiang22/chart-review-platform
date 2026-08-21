---
field_id: crit_c_date
prompt: Date varices were seen (endoscopy or imaging)
answer_schema:
  type: string
cardinality: one
group: step1_criteria
---

# Criterion: crit_c_date (evidence date)

## Definition
The exam date on which varices were demonstrated (earliest qualifying). Blank when crit_c_varices is not_met.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.
