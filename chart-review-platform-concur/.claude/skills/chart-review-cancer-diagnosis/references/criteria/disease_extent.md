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
derivation: 'has_distant_metastasis == "yes" AND has_local_recurrence == "yes" ? "local_recurrent_and_metastatic" : has_distant_metastasis == "yes" ? "metastatic" : has_local_recurrence == "yes" ? "local_recurrent" : "no_info"'
---

# Criterion: disease_extent (computed)

## Definition

The overall extent of disease at the index/enrollment assessment. This field is
**computed** — not extracted directly — from the two leaf criteria
`has_distant_metastasis` and `has_local_recurrence`:

| distant metastasis | local recurrence | → disease_extent |
|---|---|---|
| yes | yes | `local_recurrent_and_metastatic` |
| yes | no / no_info | `metastatic` |
| no / no_info | yes | `local_recurrent` |
| no / no_info | no / no_info | `no_info` |

## Extraction guidance

Do not answer this field directly — it is auto-derived from the two leaves and
shown on the **Computed** panel. To change it, fix `has_distant_metastasis` or
`has_local_recurrence`; this value recomputes. Confirm the computed value during
validation.
