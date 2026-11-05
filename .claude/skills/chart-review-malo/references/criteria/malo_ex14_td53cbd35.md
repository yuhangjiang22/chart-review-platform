---
field_id: malo_ex14_td53cbd35
prompt: "Does the chart document: device removal more than 6 months prior to screening (Visit 1)?"
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: ex14
polarity: exclusion
source_trait_id: "td53cbd35"
source_criterion_id: EX14
---

# Trait: device removal more than 6 months prior to screening (Visit 1)

## Protocol criterion this trait came from

**EX14** (exclusion), verbatim:

> Have a prior or planned endoscopic procedure and/or device-based therapy for obesity,
> such as, but not limited to
>  mucosal ablation
>  laparoscopic adjustable gastric banding
>  intragastric balloon, or
>  duodenal-jejunal endoluminal liner.
> Exception: Prior device-based therapy is acceptable if device removal was more than
> 6 months prior to screening (Visit 1).

## How to answer

Answer only this trait. Use the criterion text above, and any definition
above, as context for what the words mean — not as extra conditions to check.

No decision rules have been written for this trait. If it turns on a term the
protocol does not define, record the chart's own wording in `rationale` and
answer `unknown` rather than applying a threshold of your own.
