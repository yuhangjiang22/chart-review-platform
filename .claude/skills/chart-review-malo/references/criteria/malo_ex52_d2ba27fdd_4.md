---
field_id: malo_ex52_d2ba27fdd_4
prompt: "Does the chart document: child?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex52
polarity: exclusion
source_trait_id: "d2ba27fdd/4"
source_criterion_id: EX52
---

# Trait: child

## Protocol criterion this trait came from

**EX52** (exclusion), verbatim:

> Are investigator site personnel directly affiliated with this study and/or their immediate
> family. Immediate family is defined as a spouse, legal partner, parent, child, or sibling,
> whether biological or legally adopted.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
