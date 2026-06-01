---
field_id: icd_lung_cancer_present
schema_hash: ae7876eda31a24ad
prompt: Is an ICD-10 C34.* code on the problem list or any encounter diagnosis?
answer_schema:
  enum:
  - true
  - false
cardinality: one
time_window: lookback_24mo
group: codes
uses:
  code_sets:
  - lung_cancer_icd10
  - codes_icd_lung_cancer_present
  edge_cases:
  - z85_118_personal_history_excluded
  exemplars:
  - pt_017_history_only
  keyword_sets:
  - kw_icd_lung_cancer_present
---

# Criterion: icd_lung_cancer_present

## Definition

An ICD-10-CM code in the C34.* family appears on the patient's problem list or any encounter diagnosis within the lookback window.

## Extraction guidance

Query CONDITION_OCCURRENCE for ICD-10-CM C34.* codes. Personal-history codes (Z85.118) do not qualify here.

## Examples

- C34.10 on a 2025-09-12 encounter → `yes`
- Only Z85.118 ("personal history of malignant neoplasm of bronchus and lung") → `no`
- No relevant codes → `no`

