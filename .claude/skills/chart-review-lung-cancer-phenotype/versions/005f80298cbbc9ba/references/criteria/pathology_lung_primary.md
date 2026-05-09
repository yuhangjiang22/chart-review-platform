---
field_id: pathology_lung_primary
schema_hash: 893c998bc3fad868
prompt: What primary site / histology does the pathology report indicate?
answer_schema:
  enum:
  - nsclc
  - sclc
  - other_lung
  - non_lung
  - no_info
cardinality: one
time_window: lookback_24mo
group: pathology
is_applicable_when: pathology_report_present == 'yes'
uses:
  keyword_sets:
  - pathology_terms
  - lung_anatomy
  - kw_pathology_lung_primary
  edge_cases:
  - carcinoid_classified_as_other_lung
---

# Criterion: pathology_lung_primary

## Definition

NSCLC subtypes (adenocarcinoma, squamous cell carcinoma, large-cell carcinoma) collapse to `nsclc`. Carcinoid tumors map to `other_lung`. Mesothelioma maps to `non_lung`. Metastatic disease without lung primary → `non_lung`.

## Conflict resolution

If multiple pathology reports conflict, prefer the most recent unless a documented re-read exists. If a re-read is documented, the re-read wins regardless of date.

## Extraction guidance

Apply WHO mapping below.

## Examples

- "Adenocarcinoma of the lung" → `nsclc`
- "Small cell carcinoma, lung" → `sclc`
- "Carcinoid tumor of the lung" → `other_lung`
- "Metastatic colorectal carcinoma" → `non_lung`

