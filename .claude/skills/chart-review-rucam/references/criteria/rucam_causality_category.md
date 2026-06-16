---
field_id: rucam_causality_category
prompt: RUCAM causality category
answer_schema:
  enum: ["highly_probable", "probable", "possible", "unlikely", "excluded"]
cardinality: one
group: rucam
derivation: '(item_1_time_to_onset + item_2_course + item_5_exclusion) >= 9 ? "highly_probable" : (item_1_time_to_onset + item_2_course + item_5_exclusion) >= 6 ? "probable" : (item_1_time_to_onset + item_2_course + item_5_exclusion) >= 3 ? "possible" : (item_1_time_to_onset + item_2_course + item_5_exclusion) >= 1 ? "unlikely" : "excluded"'
---

# Criterion: rucam_causality_category (computed)

## Definition

Standard RUCAM interpretation of the total score — **computed**, not extracted:
≥9 highly probable, 6–8 probable, 3–5 possible, 1–2 unlikely, ≤0 excluded.
(Slice: derived from items 1, 2, and 5.)
