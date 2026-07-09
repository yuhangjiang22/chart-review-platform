---
field_id: g2_cmv_ebv_hsv_ruled_out
prompt: For Item 5 (Group II), is acute CMV/EBV/HSV hepatitis ruled out — by serology or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g2_cmv_ebv_hsv_ruled_out

## Definition

Group II cause 5 of 5 — **acute CMV / EBV / HSV hepatitis**, window T0 ± 30 days.
`yes` only if **(a)** ruled out by objective testing (negative CMV/EBV/HSV serologies
or PCR in the window) or **(b)** explicitly excluded by a note. `no` if not assessed,
indeterminate, or present.

## Extraction guidance

Check `CMV_acute_dx` / `EBV_acute_dx` / `HSV_hepatitis_dx` and the serologies
(`CMV_IgM`, `CMV_PCR`, `EBV_VCA_IgM`, `EBV_PCR`, `HSV_PCR`) with dates in [-30, +30]
(per `references/scoring/item-5-exclusion.md`, Group II). Cite the negatives or span.
