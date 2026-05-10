---
field_id: lung_cancer_status
schema_hash: 50f0a9499acbaf1a
prompt: Final phenotype label.
answer_schema:
  enum:
  - confirmed
  - probable
  - absent
group: final
derivation: 'pathology_confirms_lung_cancer == true ? ''confirmed'' : (clinical_diagnosis_lung_cancer
  == true OR icd_lung_cancer_present == ''yes'') ? ''probable'' : ''absent'''
is_final_output: true
---

# Criterion: lung_cancer_status

## Rationale

- `confirmed` requires pathology evidence — the highest-tier evidence available in routine EHR.
- `probable` allows two paths: clinical-diagnosis-with-imaging-support, or an ICD code (the weakest signal but included to match how chart reviewers operate when full pathology is missing).
- `absent` is asserted only when all leaf fields have been evaluated and none support lung cancer.

