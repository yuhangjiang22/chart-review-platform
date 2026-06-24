---
field_id: mattis_drs
prompt: What is the documented Mattis Dementia Rating Scale (DRS-2) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 144
cardinality: one
group: cognitive_scales
---

# Criterion: mattis_drs

The documented **Mattis DRS-2 total score** (0–144; higher = better). Extract the
raw integer (e.g. "DRS-2 132/144" → `132`). If none documented, leave unanswered.
There is no single universal cutoff; interpret with version + age/education norms.

**Evidence:** cite the score span.
