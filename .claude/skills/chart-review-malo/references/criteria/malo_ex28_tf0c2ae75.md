---
field_id: malo_ex28_tf0c2ae75
prompt: "Does the chart document: treatment for hypothyroidism with thyroid hormone replacement dose stable for at least 2 months prior to screening (Visit 1)?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex28
polarity: exclusion
source_trait_id: "tf0c2ae75"
source_criterion_id: EX28
---

# Trait: treatment for hypothyroidism with thyroid hormone replacement dose stable for at least 2 months prior to screening (Visit 1)

## Protocol criterion this trait came from

**EX28** (exclusion), verbatim:

> Have evidence of significant, uncontrolled endocrine abnormality, in the opinion of
> the investigator. For example, thyrotoxicosis or adrenal crisis
> Note: Participants receiving treatment for hypothyroidism may be included, provided
> their thyroid hormone replacement dose has been stable for at least 2 months prior to
> screening (Visit 1).

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
