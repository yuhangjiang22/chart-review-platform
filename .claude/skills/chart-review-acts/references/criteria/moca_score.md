---
field_id: moca_score
prompt: What is the documented Montreal Cognitive Assessment (MoCA) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 30
cardinality: one
group: cognitive_scales
---

# Criterion: moca_score

The documented **MoCA total score** (0–30; higher = better cognition). Extract the
raw integer score only — e.g. "MoCA 21/30" → `21`. Apply the official +1
education adjustment only if the note states the adjusted score; otherwise record
the raw score as written. Do NOT infer from a severity word alone. If no MoCA
score is documented, leave unanswered. Interpretation (for context, not for this
field): ≥26 normal, 18–25 mild, 10–17 moderate, 0–9 severe.

**Evidence:** cite the score span (e.g. "MoCA 21/30").
