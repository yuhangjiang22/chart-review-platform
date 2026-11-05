---
field_id: malo_ex33_taaebe8a0
prompt: "Does the chart document: answered “yes” to Question 5 on the “Suicidal Ideation” portion of the C-SSRS and the ideation occurred within the past month?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex33
polarity: exclusion
source_trait_id: "taaebe8a0"
source_criterion_id: EX33
---

# Trait: answered “yes” to Question 5 on the “Suicidal Ideation” portion of the C-SSRS and the ideation occurred within the past month

## Protocol criterion this trait came from

**EX33** (exclusion), verbatim:

> Have answered “yes” to either Question 4 or Question 5 on the “Suicidal Ideation”
> portion of the C-SSRS and the ideation occurred within the past month
> OR
> Have answered “yes” to any of the suicide-related behaviors on the “suicidal behavior”
> portion of the C-SSRS and the behavior occurred within the past month.
> NOTE: Non-suicidal self-injurious behavior is not considered a suicide-related
> behavior.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
