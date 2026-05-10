---
field_id: age_gt_65
prompt: Is the patient older than 65 at the index date?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
---

## Definition

The HAS-BLED E component scores 1 point if the patient is older than 65
at the index date. This is a point-in-time evaluation — age is a property
of the patient relative to the index date, not a windowed condition.
Hence no `time_window` is set in the frontmatter (per Phase 4.6 of the
build interview guide: point-in-time attributes don't need a window).

## Extraction guidance

- Compute integer years between date of birth (structured demographic)
  and the index date.
- Round down (a 65-year-and-1-day-old at the index → "yes").

## Examples

**Satisfying ("yes"):**
- DOB 1955-06-01, index 2025-01-15 → age 69 → yes
- DOB 1959-12-15, index 2025-01-15 → age 65 (just turned 65) → yes

**Non-satisfying ("no"):**
- DOB 1962-01-01, index 2025-01-15 → age 63 → no
- DOB 1960-12-15, index 2025-01-15 → age 64 → no

## Boundary / failure modes

- Patient turns 65 on the index date → "yes" (the criterion is "> 65"
  but Pisters 2010 used ≥65 in practice; we follow the more inclusive
  interpretation).
- Patient turns 65 the day after the index → "no"
- DOB unknown → escalate
