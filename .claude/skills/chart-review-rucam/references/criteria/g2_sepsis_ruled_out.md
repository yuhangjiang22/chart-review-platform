---
field_id: g2_sepsis_ruled_out
prompt: For Item 5 (Group II), is sepsis/bacteremia ruled out — by workup or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g2_sepsis_ruled_out

## Definition

Group II cause 2 of 5 — **sepsis / bacteremia** (a plausible non-drug cause of a
transaminitis), window T0 − 365 to T0 + 30 days. `yes` only if **(a)** ruled out by
workup (no septic episode / negative cultures in the window) or **(b)** explicitly
excluded by a note. `no` if not assessed, indeterminate, or present.

## Extraction guidance

Check `get_conditions` for `sepsis_dx` / `bacteremia_dx` / `septicemia_dx` and
admission notes in the window, plus explicit note exclusions (per
`references/scoring/item-5-exclusion.md`, Group II). A structured flag of 0 alone is
NOT a rule-out. Cite the evidence.

**A documented-negative sepsis workup rules it out — don't require a literal "sepsis
excluded" note.** Negative blood cultures, low/normal procalcitonin, or a clinician
documenting no septic source / low suspicion in the window = ruled out → `yes` (this is
note-documented evidence, distinct from the structured flag=0 that alone is insufficient).
Reserve `no` for a documented septic episode, an indeterminate workup, or no assessment
at all.
