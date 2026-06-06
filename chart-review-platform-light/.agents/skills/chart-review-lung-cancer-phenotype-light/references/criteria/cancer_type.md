---
field_id: cancer_type
prompt: What is the cancer histology type documented for this patient?
answer_schema:
  enum:
    - squamous_cell_carcinoma
    - adenocarcinoma
    - lymphoma
    - sarcoma
    - melanoma
    - neuroendocrine_tumor
    - no_info
cardinality: one
group: characterization
---

# Criterion: cancer_type

## Definition

The histologic type of the primary malignancy as documented by pathology
(preferred) or the treating oncologist.

## Extraction guidance

Prefer the surgical/biopsy pathology final diagnosis over narrative notes.
Map descriptive terms to the enum:

- "small cell carcinoma" / "carcinoid tumor" / "neuroendocrine carcinoma" → `neuroendocrine_tumor`
- "adenocarcinoma" (of any site stated) → `adenocarcinoma`
- "squamous cell carcinoma" → `squamous_cell_carcinoma`
- lymphoma subtypes (e.g. "diffuse large B-cell lymphoma") → `lymphoma`
- sarcoma subtypes (e.g. "leiomyosarcoma") → `sarcoma`
- "melanoma" → `melanoma`

Use `no_info` when no note states a histology (e.g. imaging-only workup with no
pathology, or notes that mention "malignancy" without a histologic type).

## Examples

- "Final diagnosis: Squamous cell carcinoma, moderately differentiated" → `squamous_cell_carcinoma`
- "Adenocarcinoma of the lung, T2N1M0" → `adenocarcinoma`
- "EBUS-TBNA: small cell carcinoma" → `neuroendocrine_tumor`
- Imaging shows a mass, no pathology in the chart, no stated histology → `no_info`
