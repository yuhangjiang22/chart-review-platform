---
field_id: malo_ex8_t8942ea38
prompt: "Does the chart document: MELD score over 12 approved by the Medical Monitor?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex8
polarity: exclusion
source_trait_id: "t8942ea38"
source_criterion_id: EX8
---

# Trait: MELD score over 12 approved by the Medical Monitor

## Protocol criterion this trait came from

**EX8** (exclusion), verbatim:

> MELD score >12.
> Exception: Participants with a MELD score over 12 may be considered for inclusion in
> the study if approved by the Medical Monitor. This is allowed when the elevated MELD
> score is due to increased total bilirubin from Gilbert's syndrome, increased INR from
> anticoagulation, or increased creatinine from isolated kidney disease unrelated to liver
> disease. These participants are not eligible to be evaluated for primary end point of a
> MELD increase to 15 or more.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
