---
field_id: g1_biliary_obstruction_ruled_out
prompt: For Item 5 (Group I), is biliary obstruction ruled out — by imaging or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g1_biliary_obstruction_ruled_out

## Definition

Group I cause 4 of 6 — **biliary obstruction** within T0 ± 30 days. `yes` only if
**(a)** ruled out by objective testing (imaging showing no biliary dilation /
obstruction) or **(b)** explicitly excluded by a note. `no` if not assessed,
indeterminate, or present.

## Extraction guidance

Check `get_conditions` / structured biliary flags and imaging notes (US/CT/MRCP
showing no dilation) in the ±30-day window, plus explicit note exclusions (per
`references/scoring/item-5-exclusion.md`, Group I #4). Cite the imaging or the span.
