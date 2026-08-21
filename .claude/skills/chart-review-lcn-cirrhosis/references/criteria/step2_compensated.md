---
field_id: step2_compensated
prompt: Step 2 - was the patient compensated at the index date? (computed)
answer_schema:
  enum: [met, not_met]
cardinality: one
group: computed
derivation: 'decompensated_365d == "no" AND meld_na_ge_15 != "yes" AND ctp_class != "B" AND ctp_class != "C" AND shunt_ever == "no" ? "met" : "not_met"'
---

# Computed: step2_compensated

**Computed - do not answer directly.** Compensated at index = NO decompensation
within 365 days, current MELD-Na NOT >=15, current CTP NOT B/C, and NO
TIPS/BRTO/shunt at any time. `not_assessable` MELD-Na or CTP does not
disqualify (absence of inputs is not evidence of severity).
