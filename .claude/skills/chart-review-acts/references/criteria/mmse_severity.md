---
field_id: mmse_severity
prompt: MMSE severity band (computed).
answer_schema:
  enum: ["normal", "mild", "moderate", "severe"]
cardinality: one
group: cognitive_scales
derivation: 'mmse_score >= 24 ? "normal" : mmse_score >= 19 ? "mild" : mmse_score >= 10 ? "moderate" : "severe"'
---

# Criterion: mmse_severity (computed)

The MMSE severity band, **computed** from `mmse_score` (≥24 normal, 19–23 mild,
10–18 moderate, ≤9 severe). Do not answer directly — fix `mmse_score`.
