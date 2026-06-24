---
field_id: smoking_duration
prompt: For how many years has/did the patient smoke?
answer_schema:
  type: integer
  minimum: 0
  maximum: 100
cardinality: one
group: smoking
is_applicable_when: 'smoking_status in ["current", "former"]'
---

# Criterion: smoking_duration

The documented **duration of smoking in years**: "smoked for 40 years" → `40`;
"20-year smoking history" → `20`. Applies only to current/former smokers. If not
documented, leave unanswered (do not infer from pack-years).

**Evidence:** cite the duration span.
