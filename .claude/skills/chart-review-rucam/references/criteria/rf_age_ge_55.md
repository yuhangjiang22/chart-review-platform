---
field_id: rf_age_ge_55
prompt: Is the patient age ≥ 55 years at the liver-injury date (a RUCAM Item 3 risk factor)?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: rf_age_ge_55

## Definition

Whether the patient is **≥ 55 years old at the liver-injury date** — the age risk
factor for RUCAM Item 3. Answer `no` when age is < 55.

## Extraction guidance

Use `get_patient_summary` `AGE` (years at the liver-injury date): `yes` if ≥ 55,
otherwise `no`. If the notes clearly contradict the structured age, document it, but
prefer the structured `AGE`.
