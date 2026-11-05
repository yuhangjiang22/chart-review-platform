---
field_id: malo_ex44_t62d77ee5
prompt: "Does the chart document: prescribed medications (other than incretin receptor agonists) intended to promote weight loss within 3 months prior to screening visit?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex44
polarity: exclusion
source_trait_id: "t62d77ee5"
source_criterion_id: EX44
---

# Trait: prescribed medications (other than incretin receptor agonists) intended to promote weight loss within 3 months prior to screening visit

## Protocol criterion this trait came from

**EX44** (exclusion), verbatim:

> Have taken within 3 months prior to screening visit or between screening and
> randomization visit, prescribed medications (other than incretin receptor agonists like
> GLP-1 Ras, GIP/GLP-1/Glucagon Ras, GLP-1/Glucagon Ras, GIP/GLP-1 Ras) or
> alternative remedies intended to promote weight loss. Examples include, but not limited
> to:
>  Orlistat
>  Sibutramine
>  Phenylpropanolamine
>  Mazindol
>  Phentermine
>  Phentermine/Topiramate combination
>  Naltrexone/Bupropion

## Definitions supplied by the protocol

- *Examples include, but not limited to:
 Orlistat
 Sibutramine
 Phenylpropanolamine
 Mazindol
 Phentermine
 Phentermine/Topiramate combination
 Naltrexone/Bupropion*
- *like
GLP-1 Ras, GIP/GLP-1/Glucagon Ras, GLP-1/Glucagon Ras, GIP/GLP-1 Ras*

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
