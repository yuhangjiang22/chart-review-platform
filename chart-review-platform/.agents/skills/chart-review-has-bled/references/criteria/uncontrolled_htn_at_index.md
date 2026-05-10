---
field_id: uncontrolled_htn_at_index
prompt: At the index date, is the patient's systolic BP > 160 mmHg (the HAS-BLED H criterion)?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
---

## Definition

The HAS-BLED H component scores 1 point for *current* uncontrolled
hypertension defined as SBP > 160 mmHg, NOT a history of HTN diagnosis.
This is a point-in-time evaluation — at the index date — so this
criterion deliberately has no `time_window`: the index date itself is
the assessment moment.

## Extraction guidance

- Use the most recent SBP measurement at or within 1 day of the index
  encounter.
- If multiple readings, use the highest documented SBP at the visit.
- White-coat readings still count if that's what's documented.
- Diastolic BP is NOT part of HAS-BLED H.

## Examples

**Satisfying ("yes"):**
- Index visit BP recorded as 168/92 → "yes"
- Multiple readings: 145/90, 172/88 → use 172 → "yes"

**Non-satisfying ("no"):**
- BP 142/90 at index → "no" (HAS-BLED uses 160 as the cutoff)
- BP 158/95 → "no"

## Boundary / failure modes

- Exactly 160 mmHg → "no" (HAS-BLED uses > 160, strict)
- BP not measured at the index visit → escalate; do not assume
- Hospitalized patient with crisis BP 220 → "yes" (the score doesn't
  carve out acute settings; this is a point-in-time read)
