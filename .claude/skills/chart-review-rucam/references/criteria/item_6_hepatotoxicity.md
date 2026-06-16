---
field_id: item_6_hepatotoxicity
prompt: RUCAM Item 6 — prior hepatotoxicity knowledge score
answer_schema:
  enum: [2, 1, 0]
cardinality: one
group: rucam
---

# Criterion: item_6_hepatotoxicity

## Definition

RUCAM Item 6 score for how well the suspect drug's hepatotoxicity is established
in the literature/label.

## Extraction guidance

Follow `references/scoring/item-6-hepatotoxicity.md`. Use
`get_hepatotoxicity_category(<suspect drug>)` (LiverTox): category A → `2`
(reaction labeled / well known), category B → `1` (published case reports, not
labeled), category C/D/E or not found → `0`. Score (one of `2`, `1`, `0`).
