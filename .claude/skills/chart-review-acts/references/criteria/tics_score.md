---
field_id: tics_score
prompt: What is the documented Telephone Interview for Cognitive Status (TICS) score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 41
cardinality: one
group: cognitive_scales
---

# Criterion: tics_score

The documented **TICS score** (0–41 for the standard form; higher = better).
Extract the raw integer; capture the value as stated even if a modified form uses
a different denominator. If none documented, leave unanswered.

**Evidence:** cite the score span.
