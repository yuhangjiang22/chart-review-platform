---
field_id: t1ddds_status
prompt: What is the completion status of the T1D-DDS (Type 1 Diabetes Distress Scale, 28-item)?
answer_schema:
  enum: [present_with_score, present_without_score, mentioned_planned, blank_template, copied_forward, not_present, uncertain]
cardinality: one
group: surveys
---

# Criterion: t1ddds_status

## Definition

The completion status of the **T1D-DDS** (Type 1 Diabetes Distress Scale,
**28-item**, mean 1–6) for this patient. **Always commit one value** (labels as in
`dds17_status`).

## Extraction guidance

Confirm the **28-item T1D-specific** DDS — do not confuse it with the 17-item
DDS-17. Same label set:
`present_with_score` / `present_without_score` / `mentioned_planned` /
`blank_template` / `copied_forward` / `not_present` / `uncertain`. A generic
screening code does not identify it. Cite the row/span.
