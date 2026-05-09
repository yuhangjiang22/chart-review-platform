---
field_id: lung_cancer_status
prompt: What is the patient's status?
answer_schema:
  type: enum
  enum: [confirmed, probable, absent]
is_final_output: true
---

## Definition

Final label.

## Extraction guidance

Combine the leaves: pathology=yes → confirmed; etc.
