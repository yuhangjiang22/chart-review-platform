---
field_id: n_group1_ruled_out
prompt: For Item 5, how many of the 6 Group I causes are ruled out (by test or explicit note)?
answer_schema:
  type: integer
  minimum: 0
  maximum: 6
cardinality: one
group: rucam
role: intermediate
---

# Criterion: n_group1_ruled_out

## Definition

Count (0–6) of the six **Group I** alternative causes ruled out — HAV, HBV, HCV,
biliary obstruction, alcoholism, hypotension/shock/ischemia. A cause counts as ruled
out only if **(a)** ruled out by objective testing (negative result) or **(b)**
explicitly absent by note — **not** merely a structured flag of 0 ("not assessed").

## Extraction guidance

Anchor on `score_item5_exclusion` (structured floor), then upgrade a `not_assessed`
cause to ruled-out only with a cited negative test or explicit note exclusion (per
`references/scoring/item-5-exclusion.md`). Record the final count.
