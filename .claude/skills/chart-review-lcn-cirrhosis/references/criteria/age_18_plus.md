---
field_id: age_18_plus
prompt: Is the patient 18 or older at the index date?
answer_schema:
  enum: [yes, no]
cardinality: one
group: eligibility
---

# Criterion: age_18_plus

## Definition
The LCN definition applies to **adults >=18 years** at the index date.

## Extraction guidance
**Always commit one value.** Compute age at the index date from demographics
(structured `demographics`/person data preferred; a note header otherwise).
Cite the row/span.

## Examples
- Demographics age_at_index 62 -> `yes`
- Age 16 at index -> `no`
