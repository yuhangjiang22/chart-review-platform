---
field_id: hachinski_score
prompt: What is the documented Hachinski Ischemic Score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 18
cardinality: one
group: cognitive_scales
---

# Criterion: hachinski_score

The documented **Hachinski Ischemic Score** (0–18; higher favors a vascular /
ischemic etiology, NOT dementia severity). Extract the raw integer. If a modified
version is stated, still record the stated total. If none documented, leave
unanswered. Interpretation (context only): ≤4 favors Alzheimer/degenerative, 5–6
mixed/indeterminate, ≥7 favors vascular/multi-infarct.

**Evidence:** cite the score span.
