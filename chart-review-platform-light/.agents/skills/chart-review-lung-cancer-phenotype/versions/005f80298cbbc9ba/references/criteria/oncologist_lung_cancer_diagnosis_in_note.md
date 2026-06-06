---
field_id: oncologist_lung_cancer_diagnosis_in_note
schema_hash: 1fe940ad11aaf179
prompt: Does a treating oncologist or pulmonologist document lung cancer as the diagnosis?
answer_schema:
  enum:
  - true
  - false
  - no_info
cardinality: one
time_window: lookback_24mo
group: clinical_diagnosis
uses:
  keyword_sets:
  - kw_oncologist_lung_cancer_diagnosis_in_note
---

# Criterion: oncologist_lung_cancer_diagnosis_in_note

## Definition

A treating oncologist or pulmonologist documents lung cancer as the patient's diagnosis (active or historical). Family history mentions, "rule out" language, and provider-questioned diagnoses do **not** qualify.

## Extraction guidance

Author role must be oncologist or pulmonologist. Family history mentions do not count.

## Examples

- Oncology progress note: "Patient with stage IIIA NSCLC, currently on cisplatin/etoposide" → `yes`
- "Father with history of lung cancer" → `no`
- "Considering lung cancer in differential, awaiting biopsy" → `no_info`

