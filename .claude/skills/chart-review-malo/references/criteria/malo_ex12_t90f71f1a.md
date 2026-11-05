---
field_id: malo_ex12_t90f71f1a
prompt: "Does the chart document: body weight reduction >5 kg (11 lbs) within 3 months prior to screening?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex12
polarity: exclusion
source_trait_id: "t90f71f1a"
source_criterion_id: EX12
---

# Trait: body weight reduction >5 kg (11 lbs) within 3 months prior to screening

## Protocol criterion this trait came from

**EX12** (exclusion), verbatim:

> Have a self-reported or documented body weight reduction >5 kg (11 lbs) within
> 3 months prior to screening.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
