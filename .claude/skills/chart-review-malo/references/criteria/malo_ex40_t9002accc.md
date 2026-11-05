---
field_id: malo_ex40_t9002accc
prompt: "Does the chart document: awaiting an organ transplant?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex40
polarity: exclusion
source_trait_id: "t9002accc"
source_criterion_id: EX40
---

# Trait: awaiting an organ transplant

## Protocol criterion this trait came from

**EX40** (exclusion), verbatim:

> Have had a transplanted organ or awaiting an organ transplant.
> Note: corneal transplant (keratoplasty) is allowed.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
