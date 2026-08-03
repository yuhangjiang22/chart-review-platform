---
field_id: dds17_score
prompt: What is the documented DDS-17 mean score?
answer_schema:
  type: number
  minimum: 1
  maximum: 6
cardinality: one
group: surveys
---

# Criterion: dds17_score

## Definition

The documented **DDS-17 mean score** (1–6; higher = more distress).

## Extraction guidance

- Record the **documented mean** as written; preserve the reported value.
- **Leave unanswered (null) when no DDS-17 score is documented — never write a
  placeholder.** (This field feeds no computation, so absence must be null.)
- Compute a mean only if ALL 17 items are present, and say so in the rationale
  (`reviewer_calculated`). If a reported and a computed value differ, keep the
  reported value and flag the conflict in the rationale.
- Only meaningful when `dds17_status = present_with_score`. Cite the row/span.

## Examples

- "DDS-17 mean 2.4" → `2.4`
- DDS-17 done, no score recorded → (leave blank)
