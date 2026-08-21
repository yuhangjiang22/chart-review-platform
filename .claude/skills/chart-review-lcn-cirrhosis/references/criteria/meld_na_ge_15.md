---
field_id: meld_na_ge_15
prompt: Is the current MELD-Na >=15 at the index date?
answer_schema:
  enum: [yes, no, not_assessable]
cardinality: one
group: severity
---

# Severity: MELD-Na >=15 (current)

## Definition
A **current MELD-Na >=15** at the index date disqualifies compensation
(LCN Cirrhosis Severity criterion).

## Extraction guidance
**Always commit one value:**
- **`yes`** — a documented MELD-Na >=15 current at index, or computed >=15 from
  labs at/near index (bilirubin, INR, creatinine, sodium; say `computed`).
- **`no`** — documented/computed MELD-Na <15.
- **`not_assessable`** — inputs unavailable at index. Does NOT disqualify.
Cite the note span or the lab rows; state the lab dates.

## Examples
- "MELD-Na 18" in a hepatology note at index -> `yes`
- "MELD-Na 9" -> `no`
- No bilirubin/INR/creatinine near index -> `not_assessable`
