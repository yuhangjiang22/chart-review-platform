---
field_id: malo_ex23_tf824293b
prompt: "Does the chart document: known, clinically significant gastric emptying abnormality?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex23
polarity: exclusion
source_trait_id: "tf824293b"
source_criterion_id: EX23
---

# Trait: known, clinically significant gastric emptying abnormality

## Protocol criterion this trait came from

**EX23** (exclusion), verbatim:

> Have a known, clinically significant gastric emptying abnormality (for example,
> severe diabetic gastroparesis or gastric outlet obstruction), or chronically take
> medications directly affecting GI motility.

## Definitions supplied by the protocol

- *for example,
severe diabetic gastroparesis or gastric outlet obstruction*

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
