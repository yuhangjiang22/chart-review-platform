---
field_id: malo_ex41_tbddf32b9
prompt: "Does the chart document: drugs associated with hepatic steatosis for more than 2 weeks between screening and randomization visit (visit 3)?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex41
polarity: exclusion
source_trait_id: "tbddf32b9"
source_criterion_id: EX41
---

# Trait: drugs associated with hepatic steatosis for more than 2 weeks between screening and randomization visit (visit 3)

## Protocol criterion this trait came from

**EX41** (exclusion), verbatim:

> Have taken any drugs associated with hepatic steatosis (for example, amiodarone,
> valproic acid, methotrexate, tamoxifen) for more than 2 weeks in the 3 months prior to
> screening visit or between screening and randomization visit (visit 3).

## Definitions supplied by the protocol

- *for example, amiodarone,
valproic acid, methotrexate, tamoxifen*

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
