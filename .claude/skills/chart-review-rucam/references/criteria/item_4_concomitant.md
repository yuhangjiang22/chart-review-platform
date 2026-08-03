---
field_id: item_4_concomitant
prompt: RUCAM Item 4 — concomitant drugs score (computed)
answer_schema:
  enum: [0, -1, -2, -3]
cardinality: one
group: rucam
role: interpretive
required_note: "COMPUTED from concomitant_worst_timing, concomitant_worst_hepatotoxic, and concomitant_attribution — not answered directly."
derivation: 'concomitant_attribution == "yes" ? -3 : (concomitant_worst_timing == "suggestive" AND concomitant_worst_hepatotoxic == "yes") ? -2 : (concomitant_worst_timing == "suggestive" OR concomitant_worst_timing == "compatible") ? -1 : 0'
---

# Criterion: item_4_concomitant (computed)

## Definition

RUCAM Item 4 (concomitant drugs), **computed** from the worst-case concomitant drug —
do NOT answer directly:

- **−3** if `concomitant_attribution` = yes (clear evidence a co-drug is the cause).
- **−2** if worst timing `suggestive` AND that drug is a known hepatotoxin (A/B).
- **−1** if worst timing is `suggestive` or `compatible`.
- **0** otherwise (incompatible timing, or no concomitant drug).

## Extraction guidance

Answer `concomitant_worst_timing`, `concomitant_worst_hepatotoxic`,
`concomitant_attribution` (per `references/scoring/item-4-concomitant.md`); this score
derives from them.
