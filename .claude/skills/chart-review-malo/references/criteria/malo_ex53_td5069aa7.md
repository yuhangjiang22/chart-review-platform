---
field_id: malo_ex53_td5069aa7
prompt: "Does the chart document: employees of any third party involved in the study who require exclusion of their employees?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex53
polarity: exclusion
source_trait_id: "td5069aa7"
source_criterion_id: EX53
---

# Trait: employees of any third party involved in the study who require exclusion of their employees

## Protocol criterion this trait came from

**EX53** (exclusion), verbatim:

> Are Lilly employees or are employees of any third party involved in the study who
> require exclusion of their employees.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
