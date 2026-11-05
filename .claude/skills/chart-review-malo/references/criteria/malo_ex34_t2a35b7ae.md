---
field_id: malo_ex34_t2a35b7ae
prompt: "Does the chart document: history of unstable major depressive disorder within the last 2 years?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex34
polarity: exclusion
source_trait_id: "t2a35b7ae"
source_criterion_id: EX34
---

# Trait: history of unstable major depressive disorder within the last 2 years

## Protocol criterion this trait came from

**EX34** (exclusion), verbatim:

> Have a history of unstable major depressive disorder or other severe psychiatric
> disorder, such as schizophrenia, bipolar disorder, or other serious mood or anxiety
> disorder, within the last 2 years
> OR
> In the investigator’s assessment, have any significant mental health disorder that may
> put the individual at higher risk of study participation.
> Note: In the investigator’s assessment, individuals whose disease state is considered
> stable for the past 2 years and expected to remain stable during the study may be
> considered for inclusion.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
