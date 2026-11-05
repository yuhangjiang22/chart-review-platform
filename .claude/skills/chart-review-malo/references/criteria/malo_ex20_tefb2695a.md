---
field_id: malo_ex20_tefb2695a
prompt: "Does the chart document: hypoglycemia unawareness within 3 months prior to screening?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex20
polarity: exclusion
source_trait_id: "tefb2695a"
source_criterion_id: EX20
---

# Trait: hypoglycemia unawareness within 3 months prior to screening

## Protocol criterion this trait came from

**EX20** (exclusion), verbatim:

> Have a history of ketoacidosis or hyperosmolar state/coma within 3 months prior to
> screening or have had events of severe hypoglycemia or hypoglycemia unawareness
> within 3 months prior to screening.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
