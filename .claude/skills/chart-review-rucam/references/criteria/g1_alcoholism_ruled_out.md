---
field_id: g1_alcoholism_ruled_out
prompt: For Item 5 (Group I), is alcoholic liver injury ruled out — by labs/history or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g1_alcoholism_ruled_out

## Definition

Group I cause 5 of 6 — **alcoholism / alcoholic liver injury**, window T0 − 365 to
T0 + 30 days. `yes` only if **(a)** ruled out by objective evidence (e.g. negative
blood alcohol, AST:ALT < 2 with no alcohol history) or **(b)** explicitly excluded by
a note ("denies alcohol use"). `no` if not assessed, indeterminate, or present.

## Extraction guidance

Check structured alcohol flags, blood-alcohol level, and the AST:ALT ratio (≥ 2
suggests alcoholic), plus note text for an explicit exclusion (per
`references/scoring/item-5-exclusion.md`, Group I #5). Cite the evidence.
