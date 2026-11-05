---
field_id: malo_ex46_t7220bbf4
prompt: "Does the chart document: known intolerance to excipients of GLP-1 Ras, GIP/GLP-1 Ras or GIP/GLP-1/Glucagon Ra?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex46
polarity: exclusion
source_trait_id: "t7220bbf4"
source_criterion_id: EX46
---

# Trait: known intolerance to excipients of GLP-1 Ras, GIP/GLP-1 Ras or GIP/GLP-1/Glucagon Ra

## Protocol criterion this trait came from

**EX46** (exclusion), verbatim:

> Have known allergies or intolerance to
>  GLP-1 Ras
>  GIP/GLP-1 Ras, and
>  GIP/GLP-1/Glucagon Ra or excipients.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
