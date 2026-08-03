---
field_id: continued_t1d_treatment
prompt: Is continued T1D-type treatment or description documented across the record?
answer_schema:
  enum: [yes, no_info]
cardinality: one
group: longitudinal
---

# Criterion: continued_t1d_treatment

## Definition

Whether the record shows **continued type-1-consistent treatment or description**
over time — sustained insulin dependence with T1D framing (pump/CSII, basal-bolus
regimen described as type 1, ongoing endocrinology follow-up for T1D). Supports
longitudinal consistency with T1D.

## Extraction guidance

**Always commit one value:**

- **`yes`** — the longitudinal record consistently shows T1D-type management
  (ongoing insulin with type-1 framing, continued pump use, recurring T1D
  encounters).
- **`no_info`** — no such sustained pattern is documented, or the picture is mixed/
  unclear.

Cite representative rows/spans across time. This is a supporting longitudinal
signal, not a classification driver on its own.

## Examples

- Years of pump therapy with recurring endocrinology T1D notes → `yes`
- Single encounter, no longitudinal treatment picture → `no_info`
