---
field_id: sex_female
prompt: Is the patient's recorded sex female?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
---

## Definition

Recorded biological sex = female in the patient's structured demographic
data. CHA₂DS₂-VASc adds 1 point for female sex per Lip 2010, reflecting the
modestly higher stroke risk observed in women with AFib in cohort studies.

## Extraction guidance

- Read the structured demographic field `sex` (or equivalent EHR field).
- This is biological sex as recorded for clinical purposes, not gender
  identity. If the chart records both, use sex.
- If sex is missing or "unknown" / "X" / "other" in the structured data, the
  rubric requires a value — escalate to the methodologist rather than
  guessing.

## Examples

**Satisfying:**
- structured `sex: F`
- "Patient is a 68-year-old woman with AFib"

**Non-satisfying:**
- structured `sex: M`
- "Patient is a 71-year-old man"

## Boundary / failure modes

- Trans patients: use the recorded clinical sex if specified; if the chart
  has only gender identity, escalate (the original score was validated on
  binary biological sex)
- Sex unspecified / unknown → escalate
