---
field_id: malo_ex42_t370bce53
prompt: "Does the chart document: vitamin E for MASH within 6 months prior to the screening visit?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex42
polarity: exclusion
source_trait_id: "t370bce53"
source_criterion_id: EX42
---

# Trait: vitamin E for MASH within 6 months prior to the screening visit

## Protocol criterion this trait came from

**EX42** (exclusion), verbatim:

> Use agents for treatment of MASLD or MASH within 6 months prior to the screening
> visit.
> Note: participants currently treated with vitamin E, thiazolidines (for example,
> pioglitazone) or resmetirom for MASH should remain on treatment during the study
> and be on a stable dose for at least 6 months prior to screening or need to be off
> treatment for at least 6 months prior to screening.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
