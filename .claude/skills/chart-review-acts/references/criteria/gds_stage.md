---
field_id: gds_stage
prompt: What is the documented Global Deterioration Scale (GDS) stage?
answer_schema:
  enum: ["1", "2", "3", "4", "5", "6", "7"]
cardinality: one
group: staging
---

# Criterion: gds_stage

The documented **Global Deterioration Scale / Reisberg stage** (1–7; higher =
greater deterioration). "GDS stage 4" → `4`. This is the Reisberg staging scale,
NOT the Geriatric Depression Scale (that is `gds_depression_score`). If none
documented, leave unanswered.

**Evidence:** cite the stage span.
