---
field_id: rucam_causality_category
prompt: RUCAM causality category
answer_schema:
  enum: ["highly_probable", "probable", "possible", "unlikely", "excluded"]
cardinality: one
group: rucam
derivation: '(item_1_time_to_onset + item_2_course + item_3_risk_factors + item_4_concomitant + item_5_exclusion + item_6_hepatotoxicity + item_7_rechallenge) >= 9 ? "highly_probable" : (item_1_time_to_onset + item_2_course + item_3_risk_factors + item_4_concomitant + item_5_exclusion + item_6_hepatotoxicity + item_7_rechallenge) >= 6 ? "probable" : (item_1_time_to_onset + item_2_course + item_3_risk_factors + item_4_concomitant + item_5_exclusion + item_6_hepatotoxicity + item_7_rechallenge) >= 3 ? "possible" : (item_1_time_to_onset + item_2_course + item_3_risk_factors + item_4_concomitant + item_5_exclusion + item_6_hepatotoxicity + item_7_rechallenge) >= 1 ? "unlikely" : "excluded"'
---

# Criterion: rucam_causality_category (computed)

## Definition

Standard RUCAM interpretation of the total score — **computed**, not extracted:
≥9 highly probable, 6–8 probable, 3–5 possible, 1–2 unlikely, ≤0 excluded.
Derived from all 7 item scores.
