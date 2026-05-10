---
field_id: has_bled_score
prompt: What is the patient's HAS-BLED total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 9
is_final_output: false
derivation:
  kind: expression
  expr: |
    (uncontrolled_htn_at_index == "yes" ? 1 : 0)
    + (abnormal_renal_function == "yes" ? 1 : 0)
    + (abnormal_liver_function == "yes" ? 1 : 0)
    + (stroke_history == "yes" ? 1 : 0)
    + (major_bleeding_history == "yes" ? 1 : 0)
    + (labile_inr == "yes" ? 1 : 0)
    + (age_gt_65 == "yes" ? 1 : 0)
    + (concomitant_antiplatelet_or_nsaid == "yes" ? 1 : 0)
    + (excessive_alcohol_use == "yes" ? 1 : 0)
---

## Definition

Sum of the 9 HAS-BLED components, each weighted 1 point. Range 0–9.

`labile_inr` evaluates to "not_applicable" for DOAC users; the
derivation expression treats `not_applicable` as 0 (only "yes" adds a
point), per the modern interpretation that HAS-BLED-L doesn't apply to
DOACs.

## Extraction guidance

Derived field — do not fill manually. The platform evaluates the
`derivation.expr` against the leaf answers.

## Examples

- All leaves "yes" except labile_inr = "not_applicable" → 8
- Healthy 70 yo on apixaban with no other components → 1 (age only)
- Patient with HTN, age 70, on aspirin → 3

## Boundary / failure modes

- All leaves at max yields 9; the structure caps the score at 9.
- A leaf returning a value outside its enum breaks the derivation; the
  contract evaluator surfaces this.
