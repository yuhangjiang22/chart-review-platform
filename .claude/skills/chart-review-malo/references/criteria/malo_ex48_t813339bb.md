---
field_id: malo_ex48_t813339bb
prompt: "Does the chart document: contraindication to MRI examinations?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex48
polarity: exclusion
source_trait_id: "t813339bb"
source_criterion_id: EX48
---

# Trait: contraindication to MRI examinations

## Protocol criterion this trait came from

**EX48** (exclusion), verbatim:

> Unable or unwilling to undergo MRI examination (including, for example,
> claustrophobia precluding completion of an MRI examination) OR have a
> contraindication to MRI examinations, such as a presence of a cardiac pacemaker and
> implants made from metal for example
>  cochlear implant
>  nerve stimulators
>  magnetic vascular clips, and
>  metallic heart valve or other contraindications for MRI, such as weight or girth
> that exceeds the scanner's capabilities.
> Note: Investigators may offer, at their discretion, a light sedative. If the participant is not
> willing to attempt MRI with light sedation, the participant should be excluded from
> the study.

## Definitions supplied by the protocol

- *such as a presence of a cardiac pacemaker and
implants made from metal for example
 cochlear implant
 nerve stimulators
 magnetic vascular clips, and
 metallic heart valve or other contraindications for MRI*

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
