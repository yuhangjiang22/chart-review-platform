---
field_id: phq9_date
prompt: What is the PHQ-9 assessment date?
answer_schema:
  type: string
cardinality: one
group: surveys
---

# Criterion: phq9_date

## Definition

The **assessment/completion date** of the PHQ-9.

## Extraction guidance

- Report an ISO date **`YYYY-MM-DD`** (explicit assessment date preferred; note
  encounter date only when the survey was completed at that encounter).
- Leave **blank/unanswered** if no PHQ-9 or no date is documented.
- Cite the row/span carrying the date.
