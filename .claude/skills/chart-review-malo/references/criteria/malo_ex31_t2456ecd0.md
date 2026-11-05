---
field_id: malo_ex31_t2456ecd0
prompt: "Does the chart document: chronic autoimmune condition in remission and/or under stable ongoing treatment, as determined by the investigator?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex31
polarity: exclusion
source_trait_id: "t2456ecd0"
source_criterion_id: EX31
---

# Trait: chronic autoimmune condition in remission and/or under stable ongoing treatment, as determined by the investigator

## Protocol criterion this trait came from

**EX31** (exclusion), verbatim:

> Have evidence of significant, active autoimmune abnormality (for example, lupus,
> rheumatoid arthritis) that, in the opinion of the investigator, is likely to require
> concurrent treatment with systemic glucocorticoids during the study.
> Note: Chronic autoimmune conditions that are in remission and/or under stable
> ongoing treatment, as determined by the investigator, are not exclusionary
> (Section 6.9).

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
