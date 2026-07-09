---
field_id: group2_all_ruled_out
prompt: RUCAM Item 5 — are ALL Group II causes ruled out? (computed)
answer_schema:
  enum: [yes, no]
cardinality: one
group: rucam
role: interpretive
required_note: "COMPUTED — 'yes' only when all five g2_*_ruled_out flags are 'yes'. Do NOT answer directly; answer each per-cause flag."
derivation: 'count_true([g2_autoimmune_ruled_out, g2_sepsis_ruled_out, g2_chronic_hbv_hcv_ruled_out, g2_pbc_psc_ruled_out, g2_cmv_ebv_hsv_ruled_out]) == 5 ? "yes" : "no"'
---

# Criterion: group2_all_ruled_out (computed)

## Definition

Whether **all Group II** causes are ruled out — **computed** as `yes` only when all
five per-cause flags are `yes`:
`g2_autoimmune_ruled_out`, `g2_sepsis_ruled_out`, `g2_chronic_hbv_hcv_ruled_out`,
`g2_pbc_psc_ruled_out`, `g2_cmv_ebv_hsv_ruled_out`. This distinguishes Item 5's top
tier (+2, all Group I **and** Group II ruled out) from +1 (all Group I only). Do NOT
answer directly.

## Extraction guidance

Answer each of the five per-cause flags (each `yes` only when that cause is ruled out
by a negative test or an explicit note exclusion). This gate derives from them; a
missing flag leaves it — and Item 5 — **Pending**, so every Group II cause must be
assessed. See `references/scoring/item-5-exclusion.md`.
