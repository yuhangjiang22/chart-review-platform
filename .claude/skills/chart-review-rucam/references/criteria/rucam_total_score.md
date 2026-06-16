---
field_id: rucam_total_score
prompt: RUCAM total score (sum of item scores)
answer_schema:
  type: integer
cardinality: one
group: rucam
derivation: 'item_1_time_to_onset + item_2_course + item_5_exclusion'
---

# Criterion: rucam_total_score (computed)

## Definition

Sum of the RUCAM item scores — **computed**, not extracted. (This slice sums
items 1, 2, and 5; the full instrument sums all 7 items.)
