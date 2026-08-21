---
field_id: step1_cirrhosis
prompt: Step 1 - does the patient meet the LCN cirrhosis definition? (computed)
answer_schema:
  enum: [met, not_met]
cardinality: one
group: computed
derivation: '(biopsy_recent_cirrhosis == "yes" OR step1_criteria_count >= 2) AND age_18_plus == "yes" AND excl_cardiac_cirrhosis == "no" AND excl_fald == "no" ? "met" : "not_met"'
---

# Computed: step1_cirrhosis

**Computed - do not answer directly.** LCN Step 1: adult (>=18) AND (cirrhotic
biopsy within 5 years - sufficient alone - OR at least TWO of criteria A-E)
AND neither exclusion (cardiac cirrhosis, FALD) documented.

PERSISTENCE (v2 op 5): once Step 1 has been met at any date, it is PERMANENT —
a later non-invasive test must not retract the flag, and criteria windows
lapsing does not un-establish cirrhosis. This per-review field evaluates the
review's own snapshot; the longitudinal outcome scanner applies persistence
when searching for the first Step1+Step2 date.
