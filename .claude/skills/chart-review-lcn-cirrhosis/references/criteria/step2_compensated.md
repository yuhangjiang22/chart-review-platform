---
field_id: step2_compensated
prompt: Step 2 - was the patient compensated at the reference date? (computed)
answer_schema:
  enum: [met, not_met]
cardinality: one
group: computed
derivation: 'decompensated_365d == "no" AND meld_na_ge_15 != "yes" AND ctp_class != "B" AND ctp_class != "C" AND shunt_ever == "no" ? "met" : "not_met"'
---

# Computed: step2_compensated

**Computed - do not answer directly.** Compensated at the reference date (the
end of the chart) = NO counting decompensation, MELD-Na at the reference date
NOT >=15, CTP at the reference date NOT B/C, and NO TIPS/BRTO/shunt at any
time. This snapshot calibrates agent-vs-reviewer agreement; the study outcome
(the FIRST date Step 1 and Step 2 both hold, scanning forward from index) is
computed downstream from the date leaves. `not_assessable` MELD-Na or CTP does not
disqualify (absence of inputs is not evidence of severity).
