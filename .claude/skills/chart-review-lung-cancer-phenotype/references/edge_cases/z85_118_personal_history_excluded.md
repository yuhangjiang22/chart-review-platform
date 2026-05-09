---
id: z85_118_personal_history_excluded
pattern: |
  Patient has Z85.118 (personal history of malignant neoplasm of bronchus and lung)
  on the problem list, but no active C34.* code on any encounter or problem-list entry
  within the lookback window.
applies_to:
  - icd_lung_cancer_present
  - lung_cancer_status
failure_mode: Counting personal-history codes as active disease.
correct_answer_hint: 'icd_lung_cancer_present should be `false`; lung_cancer_status drives off other criteria.'
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: "2026-04-30"
  status: approved
---

# Edge Case: z85_118_personal_history_excluded

## Pattern

A patient has Z85.118 ("personal history of malignant neoplasm of bronchus and
lung") on the problem list, but no active C34.* code on any encounter or
problem-list entry within the lookback window.

This is the most common false-positive trap in lung cancer chart review.
Surveillance patients who were treated for lung cancer years ago typically
carry Z85.118 indefinitely on their problem list. The code documents a
historical fact — it does not represent active disease.

## Correct answer

`icd_lung_cancer_present` should be `false`. The Z85.118 code is a history
code and is explicitly excluded from the `lung_cancer_icd10` code set.

`lung_cancer_status` is then driven by the remaining criteria (imaging,
pathology, oncologist note). If none of those support active lung cancer,
`lung_cancer_status` = `absent`.

Do not let the presence of Z85.118 pull `lung_cancer_status` to `probable`
or `confirmed`. Only active C34.* codes satisfy `icd_lung_cancer_present`.
