---
field_id: malo_ex29_tea908dae
prompt: "Does the chart document: history of treatment for hepatocellular carcinoma?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex29
polarity: exclusion
source_trait_id: "tea908dae"
source_criterion_id: EX29
---

# Trait: history of treatment for hepatocellular carcinoma

## Protocol criterion this trait came from

**EX29** (exclusion), verbatim:

> Have a history of hepatocellular carcinoma or a history of treatment for hepatocellular
> carcinoma.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
