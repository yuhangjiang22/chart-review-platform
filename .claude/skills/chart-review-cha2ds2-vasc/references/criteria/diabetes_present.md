---
field_id: diabetes_present
prompt: Does the patient have documented diabetes mellitus (type 1 or type 2)?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: lookback_lifetime
---

## Definition

A clinical diagnosis of diabetes mellitus (type 1 or type 2) in the problem
list, or current diabetes medication therapy with DM as the documented
indication. Pre-diabetes / impaired fasting glucose / impaired glucose
tolerance do NOT qualify.

## Extraction guidance

- Problem list / encounter ICD-10: E10.x (type 1) or E11.x (type 2)
- Active glucose-lowering medication: insulin, metformin, GLP-1 agonist,
  SGLT-2 inhibitor, sulfonylurea, etc., with a DM problem-list entry
- HbA1c ≥6.5% with a clinical diagnosis (not just an isolated lab value)

## Examples

**Satisfying:**
- "PMH: Type 2 DM on metformin, last A1c 7.1%"
- ICD-10 E11.9 on the problem list
- "Insulin lispro 10 units q meal for diabetes"

**Non-satisfying:**
- "Pre-diabetes, A1c 6.0%, lifestyle intervention"
- HbA1c 6.8% on a single lab with no DM diagnosis recorded
- Metformin prescribed for PCOS without a DM diagnosis

## Boundary / failure modes

- "Diabetes in remission" or "history of gestational diabetes" → "no"
  (CHA₂DS₂-VASc counts active DM at index)
- "Steroid-induced hyperglycemia" without a DM diagnosis → "no"
- Hospitalized DKA but no chronic DM diagnosis recorded → check problem list
  closely; if a DM diagnosis was added, → "yes"
