---
field_id: concomitant_attribution
prompt: For Item 4, is there clear evidence a concomitant drug is the actual cause (positive rechallenge, distinctive signature, or explicit clinician attribution)?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: concomitant_attribution

## Definition

The Item 4 **−3 override** — clear evidence that a *concomitant* drug (not the suspect)
is the actual cause: a positive rechallenge to the co-drug, a distinctive injury
signature, or an explicit clinician attribution naming the co-drug. This is a
judgment call; `no` unless the evidence is clear.

## Extraction guidance

`yes` only with explicit note evidence attributing the injury to a concomitant drug;
otherwise `no`. Cite the attributing span.
