---
field_id: g2_chronic_hbv_hcv_ruled_out
prompt: For Item 5 (Group II), are chronic hepatitis B/C complications ruled out — by workup or an explicit note exclusion?
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: g2_chronic_hbv_hcv_ruled_out

## Definition

Group II cause 3 of 5 — **chronic hepatitis B/C complications** (flare, decompensation,
cirrhosis of a known chronic HBV/HCV), window T0 − 365 to T0 + 30 days. `yes` only if
**(a)** ruled out by objective evidence or **(b)** explicitly excluded by a note. `no`
if not assessed, indeterminate, or present (a recent flare/decompensation in the window
is a plausible non-drug cause).

## Extraction guidance

Use `get_conditions` filtered to [-365, +30] for chronic HBV/HCV and search notes for
"cirrhosis", "decompensated", "HBV flare", "HCV cirrhosis", "variceal bleed", "ascites"
(per `references/scoring/item-5-exclusion.md`, Group II). Cite the evidence.
