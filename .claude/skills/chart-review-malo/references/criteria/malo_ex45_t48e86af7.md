---
field_id: malo_ex45_t48e86af7
prompt: "Does the chart document: chronic (>14 days) systemic glucocorticoid therapy (excluding topical, intra-ocular, intranasal, or inhaled preparations) between the screening and randomization visits?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex45
polarity: exclusion
source_trait_id: "t48e86af7"
source_criterion_id: EX45
---

# Trait: chronic (>14 days) systemic glucocorticoid therapy (excluding topical, intra-ocular, intranasal, or inhaled preparations) between the screening and randomization visits

## Protocol criterion this trait came from

**EX45** (exclusion), verbatim:

> Are receiving chronic (>14 days) systemic glucocorticoid therapy (excluding topical,
> intra-ocular, intranasal, or inhaled preparations) or have received such therapy within 3
> months prior to screening, or between the screening and randomization visits

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
