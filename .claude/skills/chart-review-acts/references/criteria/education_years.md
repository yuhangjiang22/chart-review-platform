---
field_id: education_years
prompt: How many years of formal education has the patient completed?
answer_schema:
  type: integer
  minimum: 0
  maximum: 30
cardinality: one
group: demographics
---

# Criterion: education_years

The patient's **years of formal education completed** (integer). Extract a stated
number ("12 years of education", "college graduate → 16" only if the note states
the year count). Do not infer years from a degree unless the note gives the
number. If none documented, leave unanswered.

**Evidence:** cite the span.
