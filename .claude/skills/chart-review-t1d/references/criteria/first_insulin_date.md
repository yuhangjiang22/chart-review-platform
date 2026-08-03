---
field_id: first_insulin_date
prompt: What is the documented date of first insulin use?
answer_schema:
  type: string
cardinality: one
group: longitudinal
---

# Criterion: first_insulin_date

## Definition

The **earliest** documented date the patient was on any insulin product. Feeds the
longitudinal panel and the `t1d_insulin_preceded_t2d` flag.

## Extraction guidance

- Report an ISO date **`YYYY-MM-DD`** (first insulin order/administration, or a
  stated historical start; year-only → `YYYY-01-01`).
- Leave **blank/unanswered** if insulin was never used or no start date is
  documented.
- Cite the earliest insulin `drugs` row or the note span.

## Examples

- First insulin glargine order dated 2019-05-01 → `2019-05-01`
- "Started insulin as a child" (year unknown) → (leave blank; note it)
- Never on insulin → (leave blank)
