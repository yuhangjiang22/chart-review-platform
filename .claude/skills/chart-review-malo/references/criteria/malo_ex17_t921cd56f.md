---
field_id: malo_ex17_t921cd56f
prompt: "Does the chart document: recent change in glucose-lowering medication?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex17
polarity: exclusion
source_trait_id: "t921cd56f"
source_criterion_id: EX17
---

# Trait: recent change in glucose-lowering medication

## Protocol criterion this trait came from

**EX17** (exclusion), verbatim:

> Have had a recent change in glucose-lowering medication.
> Note: Participants with T2DM should be treated with a stable dose of basal insulin
> and/or oral antihyperglycemic medications for 3 months prior to screening.
> Participants who are receiving SGLT2i (for example, dapagliflozin) should be on a
> stable dose for 6 months.

## Definitions supplied by the protocol

- *Participants with T2DM should be treated with a stable dose of basal insulin
and/or oral antihyperglycemic medications for 3 months prior to screening.
Participants who are receiving SGLT2i (for example, dapagliflozin) should be on a
stable dose for 6 months.*

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
