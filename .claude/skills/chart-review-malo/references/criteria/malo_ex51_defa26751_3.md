---
field_id: malo_ex51_defa26751_3
prompt: "Does the chart document: alcohol abuse?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex51
polarity: exclusion
source_trait_id: "defa26751/3"
source_criterion_id: EX51
---

# Trait: alcohol abuse

## Protocol criterion this trait came from

**EX51** (exclusion), verbatim:

> Have any condition, unwillingness, or inability, not covered by any of the other
> exclusion criteria, which in the investigator’s opinion, might jeopardize the
> participant’s safety (for example, hypersensitivity or contraindication) or compliance
> with the protocol (for example, recreational drug use, substance abuse, or alcohol
> abuse).

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
