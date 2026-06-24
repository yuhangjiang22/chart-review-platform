---
field_id: gds_depression_score
prompt: What is the documented Geriatric Depression Scale (GDS) score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 30
cardinality: one
group: depression_scales
---

# Criterion: gds_depression_score

The documented **Geriatric Depression Scale** total (GDS-15: 0–15; GDS-30: 0–30;
higher = more depressive symptoms). Extract the raw integer as written. Note the
version in the rationale when stated. NOT the Global Deterioration Scale (that is
`gds_stage`). If none documented, leave unanswered.

**Evidence:** cite the score span.
