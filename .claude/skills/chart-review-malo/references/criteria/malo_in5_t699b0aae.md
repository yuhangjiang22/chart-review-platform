---
field_id: malo_in5_t699b0aae
prompt: "Does the chart document: intending to be pregnant?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: in5
polarity: inclusion
source_trait_id: "t699b0aae"
source_criterion_id: IN5
---

# Trait: intending to be pregnant

## Protocol criterion this trait came from

**IN5** (inclusion), verbatim:

> Assigned male at birth/assigned female at birth.
> Contraceptive use by participants should be consistent with local regulations regarding
> the methods of contraception for those participating in clinical studies For the
> contraception requirements of this protocol, see Section 10.4. Participants’ partners of
> childbearing potential must also use contraception during the study. Participants must
> not be pregnant, intending to be pregnant, breastfeeding, or intending to breastfeed.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
