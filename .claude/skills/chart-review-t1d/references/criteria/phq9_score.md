---
field_id: phq9_score
prompt: What is the documented PHQ-9 total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 27
cardinality: one
group: surveys
---

# Criterion: phq9_score

## Definition

The documented **PHQ-9 total score** (0–27; higher = more depressive symptoms).

## Extraction guidance

- Record the documented total as written; preserve the reported value.
- **Leave unanswered (null) when no PHQ-9 total is documented — never write `0`.**
  `0` is a real, valid PHQ-9 score (no symptoms), so absence must be null, not 0.
- Compute a total only if ALL 9 items are present (`reviewer_calculated`); keep the
  reported value on conflict and flag it.
- Only meaningful when `phq9_status = present_with_score`. Cite the row/span.

## Examples

- "PHQ-9 = 12" → `12`
- "PHQ-9 total 0, no depressive symptoms" → `0`
- PHQ-9 mentioned, no total → (leave blank)
