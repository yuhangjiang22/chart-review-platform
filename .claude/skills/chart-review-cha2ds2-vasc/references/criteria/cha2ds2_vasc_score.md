---
field_id: cha2ds2_vasc_score
prompt: What is the patient's CHA₂DS₂-VASc total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 9
is_final_output: false
derivation:
  kind: expression
  expr: |
    (chf_present == "yes" ? 1 : 0)
    + (hypertension_present == "yes" ? 1 : 0)
    + (age_at_index_bucket == "gte_75" ? 2 : age_at_index_bucket == "65_to_74" ? 1 : 0)
    + (diabetes_present == "yes" ? 1 : 0)
    + (stroke_or_tia_history == "yes" ? 2 : 0)
    + (vascular_disease_present == "yes" ? 1 : 0)
    + (sex_female == "yes" ? 1 : 0)
---

## Definition

The total CHA₂DS₂-VASc score: sum of points across the seven leaf components.
Range 0–9. Computed deterministically from the leaves; the agent should not
override this value directly.

## Extraction guidance

This is a derived field. The platform evaluates the `derivation.expr` against
the leaf answers. Reviewers should NOT manually fill this — instead, validate
each leaf and let the rollup compute.

## Examples

- chf=yes, htn=yes, age=gte_75, dm=yes, stroke=no, vasc=no, sex_f=yes →
  1 + 1 + 2 + 1 + 0 + 0 + 1 = 6
- All leaves "no" + male + age_lt_65 → 0
- Female 70-year-old with prior stroke → 0 + 0 + 1 + 0 + 2 + 0 + 1 = 4

## Boundary / failure modes

- A leaf returning a value outside its enum (e.g. a typo) breaks the
  derivation; the platform's contract eval surfaces this as an error.
- The score caps at 9 by construction (1+1+2+1+2+1+1 = 9 max).
