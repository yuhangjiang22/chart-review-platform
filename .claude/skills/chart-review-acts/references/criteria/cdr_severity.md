---
field_id: cdr_severity
prompt: CDR severity label (computed).
answer_schema:
  enum: ["normal", "very_mild", "mild", "moderate", "severe"]
cardinality: one
group: staging
derivation: 'cdr_global == "0" ? "normal" : cdr_global == "0.5" ? "very_mild" : cdr_global == "1" ? "mild" : cdr_global == "2" ? "moderate" : "severe"'
---

# Criterion: cdr_severity (computed)

The CDR severity label, **computed** from `cdr_global` (0 normal, 0.5 very mild,
1 mild, 2 moderate, 3 severe). Do not answer directly — fix `cdr_global`.
