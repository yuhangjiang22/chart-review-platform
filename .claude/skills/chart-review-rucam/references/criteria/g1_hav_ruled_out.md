---
field_id: g1_hav_ruled_out
prompt: For Item 5 (Group I), is acute hepatitis A ruled out — by a negative test or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g1_hav_ruled_out

## Definition

Group I cause 1 of 6 — **acute hepatitis A** within T0 ± 30 days. `yes` only if it is
**(a)** ruled out by objective testing (anti-HAV IgM tested and negative) or **(b)**
explicitly excluded by a note. `no` if not assessed, indeterminate, or present — a
structured "not assessed" flag is NOT a rule-out.

## Extraction guidance

Check `get_serology` for HAV IgM in the ±30-day window and note text for an explicit
exclusion (per `references/scoring/item-5-exclusion.md`, Group I #1). Cite the negative
result or the excluding span.
