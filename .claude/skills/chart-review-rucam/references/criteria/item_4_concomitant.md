---
field_id: item_4_concomitant
prompt: RUCAM Item 4 — concomitant drugs score
answer_schema:
  enum: [0, -1, -2, -3]
cardinality: one
group: rucam
---

# Criterion: item_4_concomitant

## Definition

RUCAM Item 4 score (≤ 0) for concomitant medications that could themselves
explain the liver injury.

## Extraction guidance

Follow `references/scoring/item-4-concomitant.md`. Use `get_medications` /
`get_drug_episodes` for co-medications and their timing, and
`get_hepatotoxicity_category` for each one's hepatotoxic potential. Score (one of
`0`, `-1`, `-2`, `-3`):
- `0` — no concomitant drug, or none with a suggestive time-to-onset.
- `-1` — concomitant drug with a suggestive/compatible time-to-onset.
- `-2` — concomitant drug with KNOWN hepatotoxicity and a suggestive onset.
- `-3` — concomitant drug with strong evidence of being the cause (positive
  rechallenge or a validated reaction).
