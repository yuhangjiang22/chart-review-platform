---
field_id: cornell_csdd
prompt: What is the documented Cornell Scale for Depression in Dementia (CSDD) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 38
cardinality: one
group: depression_scales
---

# Criterion: cornell_csdd

The documented **Cornell Scale for Depression in Dementia (CSDD) total** (0–38;
higher = more depressive symptoms). Extract the raw integer. If none documented,
leave unanswered. Interpretation (context only): <6 absence, >10 probable major
depression, >18 definite major depression.

**Evidence:** cite the score span.
