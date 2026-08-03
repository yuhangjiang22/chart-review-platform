---
field_id: earliest_t1d_date
prompt: What is the earliest documented type-1-diabetes event date?
answer_schema:
  type: string
cardinality: one
group: longitudinal
---

# Criterion: earliest_t1d_date

## Definition

The **earliest** date at which a type-1-diabetes coded event or explicit T1D
statement is documented for this patient. Feeds the longitudinal panel.

## Extraction guidance

- Report an ISO date **`YYYY-MM-DD`** (use the true event date; a note describing a
  childhood diagnosis is historical — use the stated historical date, not the note
  date). If only a year is known, use `YYYY-01-01` and note the imprecision in the
  rationale.
- Leave **blank/unanswered** if no T1D event is documented.
- Cite the earliest `conditions` row (`E10.*`) or the note span.

## Examples

- Earliest `E10.9` row dated 2019-04-02 → `2019-04-02`
- "Diagnosed with T1D in 2010" (note dated 2025) → `2010-01-01`
- No T1D event → (leave blank)
