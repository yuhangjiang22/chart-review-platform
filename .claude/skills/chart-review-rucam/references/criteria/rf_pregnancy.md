---
field_id: rf_pregnancy
prompt: Is pregnancy documented (a RUCAM Item 3 risk factor on the cholestatic/mixed track only)?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: rf_pregnancy

## Definition

Whether **pregnancy** is documented at/around the liver injury. Pregnancy is a RUCAM
Item 3 risk factor **only on the cholestatic/mixed track** — it does not count on the
hepatocellular track. Answer `no` when absent, not documented, or not applicable.

## Extraction guidance

Check `get_patient_summary` (`pregnancy`) and the notes. Answer `yes` if the patient
is documented pregnant at/around the injury; otherwise `no`. Cite the span.
