---
field_id: dr_screening_concordance
prompt: What is the patient's concordance with the ADA diabetic retinopathy screening recommendation?
answer_schema:
  type: enum
  enum: [concordant, discordant, not_applicable]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if is_diabetic == "no" then "not_applicable"
    else if eye_exam_in_window == "yes" and eye_exam_was_dilated_retinal == "yes" and eye_exam_by_eye_care_pro == "yes" then "concordant"
    else "discordant"
derivation_truth_table:
  - label: not diabetic → not_applicable (gate branch)
    inputs:
      is_diabetic: "no"
      eye_exam_in_window: "no"
      eye_exam_was_dilated_retinal: "no"
      eye_exam_by_eye_care_pro: "no"
    expected: "not_applicable"
  - label: diabetic + all exam criteria met → concordant
    inputs:
      is_diabetic: "yes"
      eye_exam_in_window: "yes"
      eye_exam_was_dilated_retinal: "yes"
      eye_exam_by_eye_care_pro: "yes"
    expected: "concordant"
  - label: diabetic + exam in window but not dilated → discordant
    inputs:
      is_diabetic: "yes"
      eye_exam_in_window: "yes"
      eye_exam_was_dilated_retinal: "no"
      eye_exam_by_eye_care_pro: "yes"
    expected: "discordant"
  - label: diabetic + no exam in window → discordant
    inputs:
      is_diabetic: "yes"
      eye_exam_in_window: "no"
      eye_exam_was_dilated_retinal: "no"
      eye_exam_by_eye_care_pro: "no"
    expected: "discordant"
  - label: diabetic + dilated exam in window but not by eye-care pro → discordant
    inputs:
      is_diabetic: "yes"
      eye_exam_in_window: "yes"
      eye_exam_was_dilated_retinal: "yes"
      eye_exam_by_eye_care_pro: "no"
    expected: "discordant"
time_window_check: skip  # derived rollup — window owned by eye_exam_in_window leaf
---

## Definition

Final concordance label rolled up from the eligibility leaf and the
three exam-quality leaves:

- **not_applicable** — patient is not diabetic; ADA recommendation
  doesn't apply.
- **concordant** — patient is diabetic AND had a dilated retinal exam
  by an eye care professional in the past 12 months.
- **discordant** — patient is diabetic but did not meet at least one
  of: (exam in window) AND (exam was dilated) AND (exam by eye care pro).

v0 does NOT split the reason for discordance (no exam vs wrong-modality
vs wrong-provider). That split is deferred to v1.

## Extraction guidance

Derived field. Reviewers should not override; corrections go to the leaves.

## Examples

- is_diabetic=no → not_applicable
- is_diabetic=yes, exam=yes, dilated=yes, eye_care_pro=yes →
  concordant
- is_diabetic=yes, exam=no → discordant
- is_diabetic=yes, exam=yes, dilated=no → discordant
- is_diabetic=yes, exam=yes, dilated=yes, eye_care_pro=no → discordant

## Boundary / failure modes

- A patient with the bilaterally-blind edge case will have
  `eye_exam_in_window == "not_applicable"` if the reviewer overrode
  per the criterion's edge-case note. The derivation here treats that
  as falsy (the `==` check fails), so the patient lands in
  `discordant`. A v1 fix should special-case `not_applicable` as
  rolled-up `not_applicable`.
