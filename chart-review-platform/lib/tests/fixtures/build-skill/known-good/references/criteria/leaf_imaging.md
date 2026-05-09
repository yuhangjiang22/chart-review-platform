---
field_id: lung_cancer_imaging_suspicious
prompt: Does imaging show suspicious findings for lung cancer?
answer_schema:
  type: enum
  enum:
    - "yes"
    - "no"
    - "not_applicable"
is_final_output: false
---

## Definition

Imaging (CT, PET, or X-ray) showing a suspicious pulmonary lesion consistent with primary lung malignancy.

## Extraction guidance

Search radiology reports for lung lesion descriptors: spiculated nodule, mass with irregular margins, PET-avid pulmonary lesion, or impression of malignancy.
