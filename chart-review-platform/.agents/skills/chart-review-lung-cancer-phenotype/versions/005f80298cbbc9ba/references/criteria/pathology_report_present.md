---
field_id: pathology_report_present
schema_hash: 6887f46d3d20536d
prompt: Is a qualifying pathology report present in the lookback window?
answer_schema:
  enum:
  - true
  - false
  - no_info
cardinality: one
time_window: lookback_24mo
group: pathology
uses:
  keyword_sets:
  - kw_pathology_report_present
---

# Criterion: pathology_report_present

## Definition

A pathology report authored by a credentialed pathologist. Surgical and biopsy specimens both qualify. Cytology-only diagnoses do not qualify here — record `no` and let `pathology_lung_primary` capture cytology separately if needed.

## Extraction guidance

Search note documents tagged pathology_report, surgical_pathology, or LOINC 11526-1.

## Examples

- "Final diagnosis: Adenocarcinoma of the lung, T2N1M0" → `yes`
- "Suspicious for malignancy, recommend re-biopsy" → `no_info`
- No pathology document found in the 24-month window → `no`

