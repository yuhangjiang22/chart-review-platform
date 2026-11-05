---
field_id: malo_ex1_t9f76e1db
prompt: "Does the chart document: varices needing treatment?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex1
polarity: exclusion
source_trait_id: "t9f76e1db"
source_criterion_id: EX1
---

# Trait: varices needing treatment

## Protocol criterion this trait came from

**EX1** (exclusion), verbatim:

> History of esophageal varices, gastric varices or varices needing treatment.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
