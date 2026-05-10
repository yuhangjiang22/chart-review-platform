---
field_id: cytology_supports_lung_primary
schema_hash: 537fbc0eee10a84e
prompt: Does cytology (no surgical/biopsy specimen available) support a lung primary?
answer_schema:
  enum:
  - true
  - false
  - no_info
cardinality: one
time_window: lookback_24mo
group: pathology
is_applicable_when: pathology_report_present == 'no'
uses:
  keyword_sets:
  - kw_cytology_supports_lung_primary
---

# Criterion: cytology_supports_lung_primary

## Definition

Fallback when surgical or biopsy pathology is unavailable. A cytology specimen
(fine-needle aspiration, sputum cytology, or pleural fluid cytology) interpreted
by a credentialed pathologist as suspicious for or diagnostic of a lung primary
malignancy. Cytology-only diagnoses do not satisfy `pathology_lung_primary` —
they are recorded here so downstream derivation can still capture them as a
weaker tier of pathology evidence.

## Extraction guidance

Only evaluated when no qualifying pathology report exists. Look for cytology reports (FNA, sputum, pleural fluid) tagged as suspicious or positive for lung primary.

