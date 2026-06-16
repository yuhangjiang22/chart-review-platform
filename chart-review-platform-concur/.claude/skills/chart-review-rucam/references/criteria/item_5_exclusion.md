---
field_id: item_5_exclusion
prompt: RUCAM Item 5 — exclusion of other causes score
answer_schema:
  enum: [2, 1, 0, -2, -3]
cardinality: one
group: rucam
---

# Criterion: item_5_exclusion

## Definition

RUCAM Item 5 score for how thoroughly alternative (non-drug) causes of liver
injury have been excluded.

## Extraction guidance

Follow `references/scoring/item-5-exclusion.md` exactly. Use `get_serology`
(HAV/HBV/HCV, CMV/EBV/HSV), `get_conditions` (biliary obstruction, autoimmune,
alcoholic, ischemic), and `get_patient_summary` (the exclusion flags). Score (one
of `2`, `1`, `0`, `-2`, `-3`):
- `2` — all major causes (groups I + II) excluded.
- `1` — all 6 group-I causes excluded.
- `0` — 5 group-I causes excluded.
- `-2` — fewer than 5 excluded.
- `-3` — a non-drug cause is highly probable.
