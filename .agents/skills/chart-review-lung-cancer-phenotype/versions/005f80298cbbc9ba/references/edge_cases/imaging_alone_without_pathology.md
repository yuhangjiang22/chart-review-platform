---
id: imaging_alone_without_pathology
pattern: |
  A CT chest report describes a lung mass or nodule, but no pathology report exists
  anywhere in the chart within the lookback window.
applies_to:
  - imaging_lung_lesion
  - lung_cancer_status
failure_mode: Marking lung_cancer_status as `confirmed` from imaging alone.
correct_answer_hint: |
  imaging_lung_lesion should be `true` if the radiologist describes a discrete lesion;
  lung_cancer_status follows the rubric (likely `probable` if other criteria support it,
  not `confirmed` since `confirmed` requires pathology).
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: "2026-04-30"
  status: approved
---

# Edge Case: imaging_alone_without_pathology

## Pattern

A CT chest report describes a lung mass or nodule suspicious for malignancy,
but no pathology report exists anywhere in the chart within the lookback window.
The imaging language is unambiguous — terms like "highly suspicious for
malignancy," "cannot exclude malignancy," or "malignant-appearing mass" appear
in the report — but no biopsy or surgical specimen has been taken or resulted.

## Correct answer

`imaging_lung_lesion` should be `true` if the radiologist describes a discrete
lesion suspicious for malignancy (see criterion definition for the threshold).

`pathology_report_present` should be `false` (or `no_info` if documents are
potentially missing rather than definitively absent).

`lung_cancer_status` should follow the rubric derivation:
- `confirmed` is **not** achievable from imaging alone. Confirmed requires
  pathology (`pathology_confirms_lung_cancer == true`).
- `probable` is reachable if `clinical_diagnosis_lung_cancer == true`
  (imaging AND oncologist note both positive) OR if an active C34.* ICD code
  is present.
- `absent` if imaging is positive but neither the oncologist note nor any
  ICD code supports the diagnosis.

The common failure mode is to shortcut from a strong imaging report to
`confirmed`. Resist this. The rubric's `confirmed` tier is specifically
reserved for pathology-supported diagnoses.
