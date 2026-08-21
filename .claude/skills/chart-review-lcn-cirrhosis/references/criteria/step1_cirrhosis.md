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
