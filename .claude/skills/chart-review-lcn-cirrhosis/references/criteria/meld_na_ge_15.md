---
field_id: meld_na_ge_15
prompt: Is the current MELD-Na >=15 at the reference date?
answer_schema:
  enum: [yes, no, not_assessable]
cardinality: one
group: severity
---

# Severity: MELD-Na >=15 (current)

## Definition
A **current MELD-Na >=15** disqualifies compensation (LCN Cirrhosis Severity
criterion). "Current" means at the REFERENCE date (the end of the chart) —
this field is a calibration snapshot. The outcome scanner separately computes
MELD-Na from the structured labs at every candidate date, so your job here is
the note-documented picture: a charted MELD-Na, or a computation from labs.

## Extraction guidance
**Always commit one value:**
- **`yes`** — a documented MELD-Na >=15 current at reference, or computed >=15
  from labs at/near reference (bilirubin, INR, creatinine, sodium; say
  `computed`).
- **`no`** — documented/computed MELD-Na <15.
- **`not_assessable`** — inputs genuinely unavailable. Does NOT disqualify.

**MANDATORY COMPUTATION:** if bilirubin, INR and creatinine are all charted on
the same day (or within a few days of each other) near the reference date, you
MUST compute and answer yes/no — `not_assessable` with the components present
is a wrong answer (a confirmed pilot false positive passed through exactly
this way). Cite the lab rows and state the lab dates.

## Examples
- "MELD-Na 18" in a hepatology note at reference -> `yes`
- "MELD-Na 9" -> `no`
- Bili 2.2 + INR 1.22 + creatinine 0.78 + Na 140 all on one day -> compute -> `no`
- No bilirubin/INR/creatinine anywhere near reference -> `not_assessable`
