---
field_id: item_7_rechallenge
prompt: RUCAM Item 7 — response to readministration score
answer_schema:
  enum: [3, 1, 0, -2]
cardinality: one
group: rucam
---

# Criterion: item_7_rechallenge

## Definition

RUCAM Item 7 score for the liver-enzyme response to re-exposure (rechallenge) of
the suspect drug.

## Extraction guidance

Follow `references/scoring/item-7-rechallenge.md`. Use `get_drug_episodes` (a
re-exposure episode after the first) and `get_lft_series` around it, plus
`get_patient_summary` (`rechallenge_flag`). Score (one of `3`, `1`, `0`, `-2`):
- `3` — positive: ALT (hepatocellular) or ALP (chole/mixed) doubles on
  re-administration of the drug alone.
- `1` — doubling on re-administration of the drug + the same co-medication(s).
- `-2` — negative rechallenge (re-exposed, no doubling).
- `0` — no rechallenge / not interpretable.
