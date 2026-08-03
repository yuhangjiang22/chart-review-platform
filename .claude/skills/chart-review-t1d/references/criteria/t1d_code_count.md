---
field_id: t1d_code_count
prompt: How many distinct type-1-diabetes diagnosis codes are documented for this patient?
answer_schema:
  type: integer
  minimum: 0
cardinality: one
group: codes
---

# Criterion: t1d_code_count

## Definition

The count of **distinct type-1-diabetes coded diagnosis events** documented for
this patient across structured data and notes. Type 1 codes are ICD-10-CM
**`E10.*`** and ICD-9-CM **`250.x1` / `250.x3`**.

## Extraction guidance

- Read `conditions` (OMOP) first; each row with an `E10.*` / `250.x1` / `250.x3`
  code is one T1D coded event. Add note-documented T1D diagnoses that are not in
  the structured table.
- **Same-day deduplication:** count a given code **once per unique code per
  calendar day** — repeated identical codes on the same day are one event.
- Commit **`0`** when no T1D codes are documented (do not leave blank — the DiCAYA
  proportion and Klompas criteria depend on this count).
- Do **NOT** count `E08.* / E09.* / E13.* / O24.*`, gestational diabetes,
  prediabetes, or hyperglycemia toward this count.
- Cite the structured rows (`source:"omop"`, `table:"conditions"`, `row_id`) or
  the note spans that establish the count.

## Examples

- Two `E10.9` rows on different dates + one in a note → `3`
- Three `E10.65` rows all dated 2025-03-04 → `1` (same-day dedup)
- Only `E11.9` and `E13.9` codes present → `0`
