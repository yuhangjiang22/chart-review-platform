---
field_id: dds17_date
prompt: What is the DDS-17 assessment date?
answer_schema:
  type: string
cardinality: one
group: surveys
---

# Criterion: dds17_date

## Definition

The **assessment/completion date** of the DDS-17.

## Extraction guidance

- Report an ISO date **`YYYY-MM-DD`**. Use the explicit assessment date; use the
  note encounter date only when the wording indicates the survey was completed at
  that encounter.
- Leave **blank/unanswered** if no DDS-17 or no date is documented.
- Cite the row/span carrying the date.
