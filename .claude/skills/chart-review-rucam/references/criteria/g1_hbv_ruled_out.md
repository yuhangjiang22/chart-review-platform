---
field_id: g1_hbv_ruled_out
prompt: For Item 5 (Group I), is acute hepatitis B ruled out — by a negative test or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g1_hbv_ruled_out

## Definition

Group I cause 2 of 6 — **acute hepatitis B** within T0 ± 30 days. `yes` only if
**(a)** ruled out by objective testing (HBsAg and anti-HBc IgM negative) or **(b)**
explicitly excluded by a note. `no` if not assessed, indeterminate, or present.

## Extraction guidance

Check `get_serology` for HBsAg + anti-HBc IgM (and any chronic-HBV history) in the
±30-day window, plus note text for an explicit exclusion (per
`references/scoring/item-5-exclusion.md`, Group I #2). Cite the negatives or the span.
