---
field_id: malo_ex21_te297fefd
prompt: "Does the chart document: receiving treatment for diabetic retinopathy in the period between screening (Visit 1) and randomization (Visit 3)?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex21
polarity: exclusion
source_trait_id: "te297fefd"
source_criterion_id: EX21
---

# Trait: receiving treatment for diabetic retinopathy in the period between screening (Visit 1) and randomization (Visit 3)

## Protocol criterion this trait came from

**EX21** (exclusion), verbatim:

> Currently receiving, planning to receive, or in need of treatment such as intravitreal
> injections of Vascular Endothelial Growth Factor inhibitors or steroids, focal/grid
> macular laser surgery, panretinal photocoagulation, or vitrectomy for diabetic
> retinopathy at screening (Visit 1) or in the period between screening (Visit 1) and
> randomization (Visit 3).

## Definitions supplied by the protocol

- *such as intravitreal
injections of Vascular Endothelial Growth Factor inhibitors or steroids, focal/grid
macular laser surgery, panretinal photocoagulation, or vitrectomy*

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
