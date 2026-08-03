---
field_id: item_5_exclusion
prompt: RUCAM Item 5 — exclusion of other causes score (computed)
answer_schema:
  enum: [2, 1, 0, -2, -3]
cardinality: one
group: rucam
role: interpretive
required_note: "COMPUTED from n_group1_ruled_out, group2_all_ruled_out, and alt_cause_explains — not answered directly."
derivation: 'alt_cause_explains == "yes" ? -3 : (n_group1_ruled_out >= 6 AND group2_all_ruled_out == "yes") ? 2 : n_group1_ruled_out >= 6 ? 1 : n_group1_ruled_out >= 4 ? 0 : -2'
---

# Criterion: item_5_exclusion (computed)

## Definition

RUCAM Item 5 (exclusion of alternative causes), **computed** from the sub-facts — do
NOT answer directly:

- **−3** if `alt_cause_explains` = yes (a non-drug cause sufficiently explains the injury; overrides the count).
- **+2** if all 6 Group I causes ruled out AND all Group II ruled out.
- **+1** if all 6 Group I ruled out (Group II not fully).
- **0** if 4–5 Group I ruled out.
- **−2** if fewer than 4 ruled out.

## Extraction guidance

Answer `n_group1_ruled_out`, `group2_all_ruled_out`, `alt_cause_explains` (per
`references/scoring/item-5-exclusion.md`); this score derives from them.
