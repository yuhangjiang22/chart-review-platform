---
field_id: npi_total
prompt: What is the documented Neuropsychiatric Inventory (NPI) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 144
cardinality: one
group: neuropsych_scales
---

# Criterion: npi_total

The documented **NPI total symptom score** (NPI-10: 0–120; NPI-12: 0–144; NPI-Q
severity: 0–36; higher = greater neuropsychiatric burden). Extract the raw total
as written; record the version in the rationale when stated. Do NOT merge in the
separate caregiver-distress score. If none documented, leave unanswered.

**Evidence:** cite the score span.
