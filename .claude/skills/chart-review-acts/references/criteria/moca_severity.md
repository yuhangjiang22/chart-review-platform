---
field_id: moca_severity
prompt: MoCA severity band (computed).
answer_schema:
  enum: ["normal", "mild", "moderate", "severe"]
cardinality: one
group: cognitive_scales
derivation: 'moca_score >= 26 ? "normal" : moca_score >= 18 ? "mild" : moca_score >= 10 ? "moderate" : "severe"'
---

# Criterion: moca_severity (computed)

The MoCA severity band, **computed** from `moca_score` per the official cutoffs
(≥26 normal, 18–25 mild, 10–17 moderate, 0–9 severe). Do not answer directly —
fix `moca_score` and this recomputes.
