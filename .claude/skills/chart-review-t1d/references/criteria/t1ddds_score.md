---
field_id: t1ddds_score
prompt: What is the documented T1D-DDS mean score?
answer_schema:
  type: number
  minimum: 1
  maximum: 6
cardinality: one
group: surveys
---

# Criterion: t1ddds_score

## Definition

The documented **T1D-DDS mean score** (1–6; higher = more distress).

## Extraction guidance

- Record the documented mean; preserve the reported value.
- **Leave unanswered (null) when no score is documented — never write a
  placeholder.**
- Compute a mean only if ALL 28 items are present (`reviewer_calculated`); keep the
  reported value on conflict and flag it.
- Only meaningful when `t1ddds_status = present_with_score`. Cite the row/span.
