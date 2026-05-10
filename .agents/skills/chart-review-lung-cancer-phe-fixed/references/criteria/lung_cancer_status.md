---
field_id: lung_cancer_status
prompt: "What is the patient's lung cancer status?"
answer_schema:
  type: enum
  enum: [confirmed, probable, absent]
is_final_output: true
cardinality: one
time_window: baseline
derivation:
  kind: expression
  expr: |
    if lung_cancer_pathology_present == "yes" then "confirmed"
    else if (lung_cancer_imaging_suspicious == "yes" and lung_cancer_clinical_mention == "yes") then "probable"
    else if lung_cancer_treatment_received == "yes" then "probable"
    else "absent"
derivation_truth_table:
  - label: pathology confirmed
    inputs:
      lung_cancer_pathology_present: "yes"
      lung_cancer_imaging_suspicious: "no"
      lung_cancer_clinical_mention: "no"
      lung_cancer_treatment_received: "no"
    expected: "confirmed"
  - label: imaging plus clinical mention
    inputs:
      lung_cancer_pathology_present: "no"
      lung_cancer_imaging_suspicious: "yes"
      lung_cancer_clinical_mention: "yes"
      lung_cancer_treatment_received: "no"
    expected: "probable"
  - label: treatment without pathology or imaging
    inputs:
      lung_cancer_pathology_present: "no"
      lung_cancer_imaging_suspicious: "no"
      lung_cancer_clinical_mention: "no"
      lung_cancer_treatment_received: "yes"
    expected: "probable"
  - label: no evidence
    inputs:
      lung_cancer_pathology_present: "no"
      lung_cancer_imaging_suspicious: "no"
      lung_cancer_clinical_mention: "no"
      lung_cancer_treatment_received: "no"
    expected: "absent"
---

# Criterion: lung_cancer_status

## Definition

The final phenotype label integrates all evidence sources using a pathology-first hierarchy:
- **Confirmed**: Pathology definitively establishes malignancy consistent with primary lung cancer.
- **Probable**: No pathology-confirmed diagnosis, but imaging shows suspicious findings AND clinical assessment mentions lung cancer, OR the patient received lung cancer-directed treatment.
- **Absent**: No credible evidence of lung cancer across all sources.

## Extraction guidance

Apply the derivation logic above after reviewing all five leaf criteria. Pathology confirmation takes precedence; if tissue diagnosis establishes malignancy, the patient is "Confirmed" regardless of other findings. In the absence of pathology, weigh imaging suspicion together with clinical mention: if both are documented, classify as "Probable." Alternatively, if the patient received lung cancer-directed treatment (chemotherapy, radiation, or surgery explicitly for lung cancer) without pathology confirmation, also classify as "Probable." If none of these criteria are met, classify as "Absent."

## Examples

**Confirming Confirmed**
- Biopsy-proven adenocarcinoma of the lung, regardless of imaging or clinical note content → confirmed

**Confirming Probable**
- CT shows 3 cm right upper lobe mass with spiculation; oncology note states "suspected NSCLC"; no pathology yet → probable
- Patient received chemotherapy for "lung cancer"; imaging not available; pathology status unknown → probable

**Confirming Absent**
- Chest X-ray normal; no clinical mention of lung cancer; no treatment → absent
- "History of lung nodule, stable 2 years, believed benign" with no malignancy mention or treatment → absent

## Failure modes

- Allowing "probable" based on imaging alone without clinical corroboration
- Assigning "confirmed" to suspected cases awaiting pathology confirmation (remain "probable" or "no_info" until pathology returns)
- Misclassifying treatment for other thoracic malignancies (e.g., esophageal cancer with radiation to mediastinum) as lung cancer treatment
