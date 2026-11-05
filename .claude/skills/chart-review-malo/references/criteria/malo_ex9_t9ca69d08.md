---
field_id: malo_ex9_t9ca69d08
prompt: "Does the chart document: average alcohol intake that exceeds 21 units per week (males)?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex9
polarity: exclusion
source_trait_id: "t9ca69d08"
source_criterion_id: EX9
---

# Trait: average alcohol intake that exceeds 21 units per week (males)

## Protocol criterion this trait came from

**EX9** (exclusion), verbatim:

> Average alcohol intake that exceeds 21 units per week (males) or 14 units per week
> (females).
> Note: 1 unit = 12 oz or 360 mL of beer; 5 oz or 150 mL of wine; 1.5 oz or 45 mL of
> distilled spirits.

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
