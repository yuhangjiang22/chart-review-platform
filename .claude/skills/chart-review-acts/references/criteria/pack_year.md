---
field_id: pack_year
prompt: What is the patient's documented cumulative smoking exposure in pack-years?
answer_schema:
  type: number
  minimum: 0
  maximum: 150
cardinality: one
group: smoking
is_applicable_when: 'smoking_status in ["current", "former"]'
---

# Criterion: pack_year

The documented **pack-year** smoking exposure (1 pack-year = 1 pack/day × 1 year).
Extract the number only: "30 pack-year history" → `30`; "smoked 1 ppd for 22.5
years" → record the stated pack-years if given, else leave unanswered (do not
compute it yourself). Applies only to current/former smokers. If not documented,
leave unanswered.

**Evidence:** cite the pack-year span.
