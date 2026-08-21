---
field_id: crit_b_date
prompt: Date of the qualifying liver-stiffness exam (VCTE >=12.5 or MRE >=5.0 kPa)
answer_schema:
  type: string
cardinality: one
group: step1_criteria
---

# Criterion: crit_b_date (evidence date)

## Definition
The exam date of the stiffness measurement that satisfies criterion B (earliest qualifying). Blank when crit_b_stiffness is not_met.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.
