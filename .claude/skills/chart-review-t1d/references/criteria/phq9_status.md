---
field_id: phq9_status
prompt: What is the completion status of the PHQ-9?
answer_schema:
  enum: [present_with_score, present_without_score, mentioned_planned, blank_template, copied_forward, not_present, uncertain]
cardinality: one
group: surveys
---

# Criterion: phq9_status

## Definition

The completion status of the **PHQ-9** (Patient Health Questionnaire-9, total
0–27) for this patient. **Always commit one value** (labels as in `dds17_status`).

## Extraction guidance

Confirm **PHQ-9** specifically (not PHQ-2 or PHQ-8). A generic screening/depression
code (CPT 96127, HCPCS G0444) may flag a candidate but does **not** by itself prove
a PHQ-9 was completed — require the name, a total score, item responses, or a
verified local form. Label set:
`present_with_score` / `present_without_score` / `mentioned_planned` /
`blank_template` / `copied_forward` / `not_present` / `uncertain`. Cite the row/span.
