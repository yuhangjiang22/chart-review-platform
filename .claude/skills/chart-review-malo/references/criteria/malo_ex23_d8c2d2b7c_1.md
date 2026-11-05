---
field_id: malo_ex23_d8c2d2b7c_1
prompt: "Does the chart document: severe diabetic gastroparesis?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex23
polarity: exclusion
source_trait_id: "d8c2d2b7c/1"
source_criterion_id: EX23
---

# Trait: severe diabetic gastroparesis

## Protocol criterion this trait came from

**EX23** (exclusion), verbatim:

> Have a known, clinically significant gastric emptying abnormality (for example,
> severe diabetic gastroparesis or gastric outlet obstruction), or chronically take
> medications directly affecting GI motility.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
