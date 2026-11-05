---
field_id: malo_ex32_tf1ddab3a
prompt: "Does the chart document: in the judgment of the investigator, actively suicidal and at significant risk for suicide?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex32
polarity: exclusion
source_trait_id: "tf1ddab3a"
source_criterion_id: EX32
---

# Trait: in the judgment of the investigator, actively suicidal and at significant risk for suicide

## Protocol criterion this trait came from

**EX32** (exclusion), verbatim:

> Are, in the judgment of the investigator, actively suicidal and therefore deemed to be
> at significant risk for suicide.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
