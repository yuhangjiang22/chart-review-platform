---
field_id: rucam_total_score
prompt: RUCAM total score (sum of item scores)
answer_schema:
  type: integer
cardinality: one
group: rucam
derivation: 'item_1_time_to_onset + item_2_course + item_3_risk_factors + item_4_concomitant + item_5_exclusion + item_6_hepatotoxicity + item_7_rechallenge'
---

# Criterion: rucam_total_score (computed)

## Definition

Sum of all 7 RUCAM item scores — **computed**, not extracted.
