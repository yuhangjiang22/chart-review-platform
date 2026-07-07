---
field_id: group2_all_ruled_out
prompt: For Item 5, are ALL Group II causes ruled out?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: group2_all_ruled_out

## Definition

Whether all **Group II** causes are ruled out — autoimmune hepatitis, sepsis/
bacteremia, chronic HBV/HCV complications, PBC/PSC, and acute CMV/EBV/HSV. Distinguishes
the top tier (+2, all Group I **and** Group II ruled out) from +1 (all Group I only).
`no` if any Group II cause is not assessed or present.

## Extraction guidance

Per `references/scoring/item-5-exclusion.md` Group II, each checked within its time
window. `yes` only if every Group II cause is (a) test-negative or (b) note-excluded.
