---
field_id: malo_ex4_t62a5a193
prompt: "Does the chart document: hepatic mass suggestive of a potential malignancy?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex4
polarity: exclusion
source_trait_id: "t62a5a193"
source_criterion_id: EX4
---

# Trait: hepatic mass suggestive of a potential malignancy

## Protocol criterion this trait came from

**EX4** (exclusion), verbatim:

> Imaging evidence of cirrhosis with portal hypertension (for example, presence of
> varices, splenomegaly, and ascites) or a hepatic mass suggestive of a potential
> malignancy.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
