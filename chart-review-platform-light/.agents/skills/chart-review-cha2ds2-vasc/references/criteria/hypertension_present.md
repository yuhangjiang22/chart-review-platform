---
field_id: hypertension_present
prompt: Does the patient have a documented hypertension diagnosis or active treatment?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: lookback_lifetime
---

## Definition

A clinical diagnosis of essential or secondary hypertension in the problem
list, or active anti-hypertensive therapy with HTN as the documented
indication. Isolated elevated BP readings without a diagnosis are NOT
sufficient (avoids overcounting white-coat or transient elevations).

## Extraction guidance

- Problem list / encounter ICD-10: I10–I15 (essential and secondary HTN)
- Active anti-hypertensive medication (any class) with an HTN problem-list entry
- Provider notes stating "hypertension well-controlled on X" or similar

## Examples

**Satisfying:**
- "PMH: hypertension, well-controlled on amlodipine"
- ICD-10 I10 on the problem list
- "Lisinopril 10 mg daily for hypertension"

**Non-satisfying:**
- One-off BP 145/92 in clinic, no diagnosis recorded
- "Lisinopril 10 mg daily for proteinuria" (HTN medication, non-HTN indication)
- "Pre-hypertension" alone

## Boundary / failure modes

- White-coat hypertension diagnosis → "yes" (still ICD-coded as HTN)
- Resolved gestational hypertension → "no" if explicitly resolved
- HTN diagnosis but no active treatment → "yes" (history alone qualifies)
