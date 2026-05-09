---
field_id: clinical_diagnosis_lung_cancer
schema_hash: 2fa2477e839913f0
prompt: Imaging plus oncologist clinical diagnosis present?
answer_schema:
  type: boolean
group: derived
derivation: imaging_lung_lesion == 'yes' AND oncologist_lung_cancer_diagnosis_in_note
  == 'yes'
---

# Criterion: clinical_diagnosis_lung_cancer

## Definition

True iff imaging shows a suspicious lung lesion AND a treating oncologist or pulmonologist documents lung cancer.

