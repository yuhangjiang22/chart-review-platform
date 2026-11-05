---
field_id: malo_ex13_t4dcbb048
prompt: "Does the chart document: planned surgical treatment for obesity?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex13
polarity: exclusion
source_trait_id: "t4dcbb048"
source_criterion_id: EX13
---

# Trait: planned surgical treatment for obesity

## Protocol criterion this trait came from

**EX13** (exclusion), verbatim:

> Have a prior or planned surgical treatment for obesity.
> Exception: The following are allowed if performed >1 year before screening (Visit 1):
>  liposuction
>  cryolipolysis, or
>  abdominoplasty.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
