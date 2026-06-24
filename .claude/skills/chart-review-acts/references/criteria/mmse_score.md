---
field_id: mmse_score
prompt: What is the documented Mini-Mental State Examination (MMSE) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 30
cardinality: one
group: cognitive_scales
---

# Criterion: mmse_score

The documented **MMSE total score** (0–30; higher = better cognition). Extract the
raw integer — "MMSE 26/30" → `26`. Do not infer from severity words. If no MMSE
score is documented, leave unanswered. Interpretation (context only): ≥24 normal,
19–23 mild, 10–18 moderate, ≤9 severe.

**Evidence:** cite the score span.
