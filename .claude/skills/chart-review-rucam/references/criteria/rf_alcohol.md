---
field_id: rf_alcohol
prompt: Is alcohol use / alcoholic liver disease documented (a RUCAM Item 3 risk factor)?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: rf_alcohol

## Definition

Whether the chart documents an **alcohol** risk factor for RUCAM Item 3 — alcohol
use disorder, alcoholic liver disease, or clinician-documented alcohol use. Answer
`no` when it is absent or not documented.

## Extraction guidance

Check `get_patient_summary` (`alcohol_use_disorder`, `alcoholic_liver_disease`) AND
the notes ("alcohol", "ETOH", "drinks", "beer", "wine", "liquor", "heavy alcohol").
**Clinician-documented alcohol use counts even if the structured flag is 0.** Answer
`yes` if present by either source; otherwise `no`. Cite the span.
