---
field_id: pre_treatment_anemia_present
schema_hash: ca4154f6dbb2694d
prompt: Is anemia (Hgb < 12 g/dL) documented in the lookback window?
answer_schema:
  type:
  - boolean
  - 'null'
group: derived
derivation: lowest_hemoglobin_in_window != null AND lowest_hemoglobin_in_window <
  12.0
---

# Criterion: pre_treatment_anemia_present

## Definition

True iff a hemoglobin measurement under 12 g/dL exists in the lookback window. Used as a context signal for downstream cohort filtering — does not affect `lung_cancer_status`.

