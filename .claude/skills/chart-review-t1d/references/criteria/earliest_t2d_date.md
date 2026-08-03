---
field_id: earliest_t2d_date
prompt: What is the earliest documented type-2-diabetes event date?
answer_schema:
  type: string
cardinality: one
group: longitudinal
---

# Criterion: earliest_t2d_date

## Definition

The **earliest** date at which a type-2-diabetes coded event or explicit T2D
statement is documented for this patient. Feeds the longitudinal panel and the
`t1d_insulin_preceded_t2d` flag.

## Extraction guidance

- Report an ISO date **`YYYY-MM-DD`** (true event date; year-only → `YYYY-01-01`,
  note the imprecision).
- Leave **blank/unanswered** if no T2D event is documented.
- Cite the earliest `conditions` row (`E11.*`) or the note span.

## Examples

- Earliest `E11.9` row dated 2022-08-15 → `2022-08-15`
- No T2D event → (leave blank)
