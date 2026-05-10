---
field_id: age_at_index_bucket
prompt: What age bucket does the patient fall into at the index date?
answer_schema:
  type: enum
  enum: [lt_65, 65_to_74, gte_75]
is_final_output: false
---

## Definition

Patient age in completed years at the index date, bucketed into the three
CHA₂DS₂-VASc age strata: <65, 65–74 inclusive, ≥75. The CHA₂DS₂-VASc score
awards 0 / 1 / 2 points respectively.

## Extraction guidance

- Compute as integer years between date of birth (structured demographic) and
  the index date.
- Round down (an 64-year-old who turns 65 on the day after index is `lt_65`).
- If date of birth is missing, return `no_info` is NOT an option here — the
  rubric requires a value. If truly missing, escalate to the methodologist.

## Examples

**Satisfying:**
- DOB 1955-06-01, index 2025-01-15 → age 69 → `65_to_74`
- DOB 1948-12-01, index 2025-01-15 → age 76 → `gte_75`
- DOB 1962-03-15, index 2025-01-15 → age 62 → `lt_65`

## Boundary / failure modes

- DOB known only to the year → assume mid-year (July 1) for the calculation
- Patient turns 65 on the index date → `65_to_74` (≥65 starts on the birthday)
- Patient turns 75 on the index date → `gte_75`
