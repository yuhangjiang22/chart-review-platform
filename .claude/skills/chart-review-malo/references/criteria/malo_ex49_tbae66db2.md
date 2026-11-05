---
field_id: malo_ex49_tbae66db2
prompt: "Does the chart document: conditions or circumstances that would interfere with the completion of MRI examinations?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex49
polarity: exclusion
source_trait_id: "tbae66db2"
source_criterion_id: EX49
---

# Trait: conditions or circumstances that would interfere with the completion of MRI examinations

## Protocol criterion this trait came from

**EX49** (exclusion), verbatim:

> Have any conditions or circumstances that, in the opinion of the investigator, would
> interfere with the completion of MRI examinations.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
