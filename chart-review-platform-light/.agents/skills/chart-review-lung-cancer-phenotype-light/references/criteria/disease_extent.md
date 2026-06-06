---
field_id: disease_extent
prompt: What is the documented extent of disease?
answer_schema:
  enum:
    - local_recurrent
    - local_recurrent_and_metastatic
    - metastatic
    - no_info
cardinality: one
group: characterization
---

# Criterion: disease_extent

## Definition

The spread of disease at the index assessment, as documented in the notes.

## Extraction guidance

- `metastatic` — distant spread is documented (e.g. hepatic, osseous, brain,
  or distant nodal metastases), without a documented local recurrence.
- `local_recurrent` — recurrence at or near the primary site / surgical margin,
  with no distant spread documented.
- `local_recurrent_and_metastatic` — BOTH a local recurrence AND distant
  metastasis are documented.
- `no_info` — extent is not stated in the notes.

Prefer oncology/pathology/imaging statements over patient-reported history.

## Examples

- "New hepatic and osseous metastases" → `metastatic`
- "Local recurrence at the prior surgical margin; no distant disease" → `local_recurrent`
- "Recurrence at the primary site plus new pulmonary metastases" → `local_recurrent_and_metastatic`
- Notes describe an initial workup with no statement of spread → `no_info`
