---
field_id: n_group1_ruled_out
prompt: RUCAM Item 5 — count of the 6 Group I causes ruled out (computed)
answer_schema:
  type: integer
  minimum: 0
  maximum: 6
cardinality: one
group: rucam
role: interpretive
required_note: "COMPUTED — the number of the six g1_*_ruled_out flags set to 'yes'. Do NOT answer directly; answer each per-cause flag."
derivation: 'count_true([g1_hav_ruled_out, g1_hbv_ruled_out, g1_hcv_ruled_out, g1_biliary_obstruction_ruled_out, g1_alcoholism_ruled_out, g1_ischemia_ruled_out])'
---

# Criterion: n_group1_ruled_out (computed)

## Definition

The number (0–6) of **Group I** alternative causes ruled out — **computed** as the
count of the six per-cause flags set to `yes`:
`g1_hav_ruled_out`, `g1_hbv_ruled_out`, `g1_hcv_ruled_out`,
`g1_biliary_obstruction_ruled_out`, `g1_alcoholism_ruled_out`, `g1_ischemia_ruled_out`.
Feeds Item 5. Do NOT answer directly.

## Extraction guidance

Answer each of the six per-cause flags (each `yes` only when that cause is ruled out
by a negative test or an explicit note exclusion). This count derives from them; a
missing flag leaves the count — and Item 5 — **Pending**, which forces every Group I
cause to be assessed rather than silently assumed ruled out. See
`references/scoring/item-5-exclusion.md`.
