---
field_id: concomitant_worst_hepatotoxic
prompt: For Item 4, is that worst-case concomitant drug a known hepatotoxin (LiverTox A or B)?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: concomitant_worst_hepatotoxic

## Definition

Whether the worst-case concomitant drug (see `concomitant_worst_timing`) is LiverTox
category **A or B**. Only A/B + `suggestive` timing upgrades Item 4 to −2. `no` when
the drug is C/D/E/not-listed or there is no concomitant drug.

## Extraction guidance

Call `get_hepatotoxicity_category` on the worst-case concomitant drug; `yes` if
category A or B, else `no`.
