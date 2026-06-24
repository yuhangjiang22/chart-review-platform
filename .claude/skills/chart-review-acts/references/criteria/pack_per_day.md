---
field_id: pack_per_day
prompt: How many packs of cigarettes per day does/did the patient smoke?
answer_schema:
  type: number
  minimum: 0
  maximum: 20
cardinality: one
group: smoking
is_applicable_when: 'smoking_status in ["current", "former"]'
---

# Criterion: pack_per_day

The documented **packs per day** (may be a decimal): "1 pack per day" → `1`;
"0.5 ppd" → `0.5`; "two packs daily" → `2`. Applies only to current/former
smokers. If not documented, leave unanswered.

**Evidence:** cite the packs-per-day span.
