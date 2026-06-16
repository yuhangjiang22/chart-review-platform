---
field_id: item_2_course
prompt: RUCAM Item 2 — course after cessation score
answer_schema:
  enum: [3, 2, 1, 0, -2]
cardinality: one
group: rucam
---

# Criterion: item_2_course

## Definition

RUCAM Item 2 score for the change in liver enzymes after stopping the suspect
drug. Scored by injury type (use `compute_r_ratio` for hepatocellular vs
cholestatic/mixed).

## Extraction guidance

Follow `references/scoring/item-2-cessation.md` exactly. Use `get_lft_series`
(ALT for hepatocellular; ALP/bilirubin for cholestatic/mixed) and the day-offsets
relative to T0. Hepatocellular ALT fall from peak after cessation — score (one of
`3`, `2`, `1`, `0`, `-2`):
- `3` — ALT falls ≥50% within 8 days.
- `2` — ALT falls ≥50% within 30 days.
- `0` — no info / persists / falls <50% by 30 days.
- `-2` — ALT falls <50% after 30 days or re-rises with the drug stopped.
