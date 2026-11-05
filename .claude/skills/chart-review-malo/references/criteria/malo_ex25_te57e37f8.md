---
field_id: malo_ex25_te57e37f8
prompt: "Does the chart document: New York Heart Association functional Classification IV congestive heart failure?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex25
polarity: exclusion
source_trait_id: "te57e37f8"
source_criterion_id: EX25
---

# Trait: New York Heart Association functional Classification IV congestive heart failure

## Protocol criterion this trait came from

**EX25** (exclusion), verbatim:

> Have New York Heart Association functional Classification IV congestive heart
> failure.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
