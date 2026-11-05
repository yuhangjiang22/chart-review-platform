---
field_id: malo_ex35_t3f98b79f
prompt: "Does the chart document: Patient Health Questionnaire-9 score of 15 or more at randomization (Visit 3)?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex35
polarity: exclusion
source_trait_id: "t3f98b79f"
source_criterion_id: EX35
---

# Trait: Patient Health Questionnaire-9 score of 15 or more at randomization (Visit 3)

## Protocol criterion this trait came from

**EX35** (exclusion), verbatim:

> Have a Patient Health Questionnaire-9 score of 15 or more at screening (Visit 1), or
> randomization (Visit 3).

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
