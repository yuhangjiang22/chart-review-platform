---
field_id: g1_hcv_ruled_out
prompt: For Item 5 (Group I), is acute hepatitis C ruled out — by a negative test or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g1_hcv_ruled_out

## Definition

Group I cause 3 of 6 — **acute hepatitis C** within T0 ± 30 days. `yes` only if
**(a)** ruled out by objective testing (anti-HCV and HCV RNA negative) or **(b)**
explicitly excluded by a note. `no` if not assessed, indeterminate, or present.

## Extraction guidance

Check `get_serology` for anti-HCV + HCV RNA (and any chronic-HCV history) in the
±30-day window, plus note text for an explicit exclusion (per
`references/scoring/item-5-exclusion.md`, Group I #3). Cite the negatives or the span.
