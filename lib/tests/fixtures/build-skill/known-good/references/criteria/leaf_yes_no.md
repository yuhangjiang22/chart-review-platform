---
field_id: lung_cancer_pathology_present
prompt: Does the pathology report document malignant lung tissue?
answer_schema:
  type: enum
  enum:
    - "yes"
    - "no"
    - "not_applicable"
is_final_output: false
---

## Definition

A pathology report (tissue biopsy, surgical specimen, or cytology) that explicitly documents malignant lung epithelial histology.

## Extraction guidance

Search clinical notes for pathology reports with specimen type = lung; report body mentioning malignancy, carcinoma, or specific lung cancer subtype.

## Examples

**Satisfying:**
- "Lung biopsy: adenocarcinoma, grade 2"

**Non-satisfying:**
- "Lung biopsy: benign hamartoma"
