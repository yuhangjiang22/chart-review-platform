---
field_id: item_1_time_to_onset
prompt: RUCAM Item 1 — time to onset score
answer_schema:
  enum: [2, 1, 0]
cardinality: one
group: rucam
---

# Criterion: item_1_time_to_onset

## Definition

RUCAM Item 1 score for the time between suspect-drug exposure and the liver-injury
event (T0). Higher = more suggestive of DILI.

## Extraction guidance

Follow `references/scoring/item-1-onset.md` exactly. Use `get_suspect_drug` and
`get_drug_episodes` for the exposure timing (days are relative to T0 = day 0).
Score (the answer MUST be one of `2`, `1`, `0`):
- `2` — onset 5–90 days from drug start (or ≤15 days from cessation): suggestive.
- `1` — onset <5 or >90 days from start (or >15 days from cessation): compatible.
- `0` — incompatible (onset before drug start, or implausibly long).
