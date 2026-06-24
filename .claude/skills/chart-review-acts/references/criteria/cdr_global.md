---
field_id: cdr_global
prompt: What is the documented global Clinical Dementia Rating (CDR)?
answer_schema:
  enum: ["0", "0.5", "1", "2", "3"]
cardinality: one
group: staging
---

# Criterion: cdr_global

The documented **global CDR** (NOT CDR Sum-of-Boxes). One of `0`, `0.5`, `1`,
`2`, `3`. "CDR 0.5" → `0.5`. If only the Sum-of-Boxes is given (e.g. "CDR-SB 4"),
do NOT convert — leave unanswered unless the global CDR is stated. Interpretation:
0 normal, 0.5 very mild, 1 mild, 2 moderate, 3 severe.

**Evidence:** cite the CDR span.
