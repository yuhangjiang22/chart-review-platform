---
field_id: lung_cancer_status
prompt: What is the patient's lung cancer status?
answer_schema:
  type: enum
  enum:
    - confirmed
    - probable
    - absent
is_final_output: true
derivation:
  kind: expression
  expr: |
    if lung_cancer_pathology_present == "yes" then "confirmed"
    else if lung_cancer_imaging_suspicious == "yes" and lung_cancer_clinical_mention == "yes" then "probable"
    else "absent"
derivation_truth_table:
  - label: pathology positive
    inputs:
      lung_cancer_pathology_present: "yes"
      lung_cancer_imaging_suspicious: "no"
      lung_cancer_clinical_mention: "no"
    expected: "confirmed"
  - label: imaging + clinical
    inputs:
      lung_cancer_pathology_present: "no"
      lung_cancer_imaging_suspicious: "yes"
      lung_cancer_clinical_mention: "yes"
    expected: "probable"
  - label: imaging alone
    inputs:
      lung_cancer_pathology_present: "no"
      lung_cancer_imaging_suspicious: "yes"
      lung_cancer_clinical_mention: "no"
    expected: "absent"
  - label: nothing
    inputs:
      lung_cancer_pathology_present: "no"
      lung_cancer_imaging_suspicious: "no"
      lung_cancer_clinical_mention: "no"
    expected: "absent"
---

## Definition

Final phenotype label per the pathology-first hierarchy.
