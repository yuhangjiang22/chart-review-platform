---
field_id: eye_exam_in_window
prompt: Did the patient have ANY eye exam (any type, any provider) in the past 12 months?
answer_schema:
  type: enum
  enum: ["yes", "no", "not_applicable"]
is_final_output: false
time_window: lookback_12mo
is_applicable_when: 'is_diabetic == "yes"'
---

## Definition

Any documented eye examination encounter in the 12-month lookback,
regardless of type or specialty. The "dilated" and "eye-care-pro"
qualifications are checked by separate atomic criteria; this leaf
captures only the gross "did an exam happen?" signal.

Gated on `is_diabetic == "yes"` — non-diabetics return
`not_applicable` via the platform's gate evaluator.

## Extraction guidance

- Encounter records: ophthalmology, optometry, ophthalmology fellow
  clinic, retina specialty
- Procedure codes: any 92002–92019 (ophthalmologic services), 92250
  (fundus photography), 92227–92228 (telescreening)
- Notes mentioning "saw ophthalmologist 6 months ago"
- Cross-organization care: if the chart references an outside eye exam
  (letter from external ophthalmology), count it.

## Examples

**Satisfying ("yes"):**
- Encounter type "ophthalmology, comprehensive eye exam" 8 months ago
- "Patient saw Dr. Lee (optometry) 4 months ago for routine check"
- Telemedicine retinal screening 10 months ago

**Non-satisfying ("no"):**
- No eye encounters in the 12-month window
- Last eye exam was 14 months ago

**Not applicable:**
- Patient is not diabetic (gated)

## Boundary / failure modes

- **Patient documented as bilaterally blind / no light perception:**
  flag for manual override; default value here is `not_applicable`
  rather than `no` (the screening's purpose — to detect retinopathy —
  is moot when the eye is no longer light-perceiving). Reviewer should
  override if their judgment differs.
- ED encounter for eye trauma: not a screening exam, doesn't qualify
  → "no" unless dilated retinal exam was specifically performed.
- Visual acuity test only (no fundus exam) → "no" — this is captured
  more granularly by `eye_exam_was_dilated_retinal`.
