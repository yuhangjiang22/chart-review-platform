---
field_id: t2d_code_count
prompt: How many distinct type-2-diabetes diagnosis codes are documented for this patient?
answer_schema:
  type: integer
  minimum: 0
cardinality: one
group: codes
---

# Criterion: t2d_code_count

## Definition

The count of **distinct type-2-diabetes coded diagnosis events** documented for
this patient across structured data and notes. Type 2 codes are ICD-10-CM
**`E11.*`** and ICD-9-CM **`250.x0` / `250.x2`**.

## Extraction guidance

- Read `conditions` (OMOP) first; each row with an `E11.*` / `250.x0` / `250.x2`
  code is one T2D coded event. Add note-documented T2D diagnoses not in the table.
- **Same-day deduplication:** count a given code once per unique code per calendar
  day.
- Commit **`0`** when no T2D codes are documented (do not leave blank).
- Do **NOT** count `E08.* / E09.* / E13.* / O24.*`, gestational diabetes,
  prediabetes, or hyperglycemia toward this count.
- Cite the structured rows or note spans that establish the count.

## Examples

- One `E11.9` row + one `E11.65` row on separate days → `2`
- No `E11.*` codes anywhere → `0`
- `E13.9` (other specified diabetes) only → `0` (not T2D)
