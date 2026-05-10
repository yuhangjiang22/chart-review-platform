---
field_id: imaging_lung_lesion
schema_hash: 91eb9b576622cb6f
prompt: Does imaging show a lung mass, nodule, or lesion suspicious for malignancy?
answer_schema:
  enum:
  - true
  - false
  - no_info
cardinality: one
time_window: lookback_24mo
group: imaging
uses:
  keyword_sets:
  - imaging_findings
  - lung_anatomy
  - kw_imaging_lung_lesion
  edge_cases:
  - imaging_alone_without_pathology
---

# Criterion: imaging_lung_lesion

## Definition

Imaging (CT chest, PET-CT, chest X-ray) shows a lung mass, nodule, or lesion suspicious for malignancy. Stable benign-appearing nodules do not qualify.

Solitary pulmonary nodules under 8 mm with no documented follow-up imaging are considered benign variants and should not satisfy this criterion.

## Examples

- "3.2 cm spiculated mass in the right upper lobe, highly suspicious for malignancy" → `yes`
- "Stable 4 mm nodule, likely granuloma" → `no`
- "No prior imaging available for comparison" → `no_info`

