---
field_id: malo_ex47_t4d8ffc0f
prompt: "Does the chart document: participation in a clinical study involving an investigational study intervention within the last 30 days?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex47
polarity: exclusion
source_trait_id: "t4d8ffc0f"
source_criterion_id: EX47
---

# Trait: participation in a clinical study involving an investigational study intervention within the last 30 days

## Protocol criterion this trait came from

**EX47** (exclusion), verbatim:

> Have participated (participation is defined as randomization) in a clinical study
> involving an investigational study intervention within the last 30 days. If the previous
> investigational study intervention is scientifically or medically incompatible with this
> study and has a long half-life, then 90 days or 5 half-lives, whichever is longer, should
> have passed before screening (Visit 1)
> Exception: Participation in observational/non-interventional studies may be permitted.

## Definitions supplied by the protocol

- *participation is defined as randomization*

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
