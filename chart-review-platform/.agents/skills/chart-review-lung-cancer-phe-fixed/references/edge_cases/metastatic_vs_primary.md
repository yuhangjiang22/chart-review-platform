---
id: metastatic_vs_primary
pattern: "Lung involvement from metastatic disease originating in another organ"
applies_to:
  - lung_cancer_pathology_present
  - lung_cancer_clinical_mention
failure_mode: "Classifying a patient with metastatic disease to the lung (e.g., colon cancer metastases) as having primary lung cancer"
correct_answer_hint: "If pathology or clinical note explicitly states the lung involvement is metastatic (e.g., 'metastatic colon adenocarcinoma to lungs'), classify pathology_present or clinical_mention as 'No' for the lung cancer phenotype. Primary lung cancer is not present; a different malignancy is."
---

# Edge Case: metastatic_vs_primary

## Pattern

Pathology or clinical documentation confirms malignancy in the lung, but the primary tumor is explicitly noted to originate in another organ (colon, breast, kidney, etc.).

## Why it matters

This guideline determines the presence of **primary lung cancer**, not malignancy of any type in the lung. Metastatic disease to the lung from a colorectal or other primary does not satisfy the phenotype. Misclassification would inflate lung cancer prevalence.

## How to handle

- If pathology explicitly states "metastatic adenocarcinoma" with a documented non-lung primary, classify pathology_present as "No."
- If a clinical note states "metastatic disease to lung secondary to [other primary]," classify clinical_mention as "No."
- If the primary site is ambiguous and the lung is suspected to be primary (vs. a satellite metastasis from an occult primary), escalate to "Probable" pending clarification.
- When in doubt, flag for adjudication or request clarification of primary vs. metastatic status.
