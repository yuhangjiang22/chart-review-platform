---
field_id: lung_cancer_pathology_present
prompt: Does the pathology report document malignant lung tissue?
answer_schema:
  type: enum
  enum: ["yes", "no", "not_applicable"]
is_final_output: false
---

## Definition

A pathology report.

## Extraction guidance

Search clinical notes for:
- ICD codes: # TODO confirm lung cancer pathology codes (C34.x range)
- Procedures: # TODO confirm biopsy / specimen codes
