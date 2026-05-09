---
field_id: lung_cancer_clinical_mention
prompt: Is there a clinical mention of lung cancer in physician notes?
answer_schema:
  type: enum
  enum:
    - "yes"
    - "no"
    - "not_applicable"
is_final_output: false
---

## Definition

A physician note, oncology consult, or problem list entry that explicitly names lung cancer as an active or suspected diagnosis.

## Extraction guidance

Search progress notes, oncology notes, and problem lists for terms: lung cancer, NSCLC, SCLC, pulmonary malignancy, bronchogenic carcinoma.
