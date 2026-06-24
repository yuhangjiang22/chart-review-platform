---
field_id: quit_time
prompt: When did the patient quit smoking (year, age at quit, or relative time)?
answer_schema:
  type: string
cardinality: one
group: smoking
is_applicable_when: 'smoking_status == "former"'
---

# Criterion: quit_time

The documented **time of smoking cessation**, as a free-text expression — a
calendar year ("quit in 2015" → `2015`), an age at quit ("quit at age 55" →
`age 55`), or a relative time ("quit 10 years ago" → `10 years ago`). Applies
only to FORMER smokers (a current smoker has not quit). If not documented, leave
unanswered.

**Evidence:** cite the quit-time span.
