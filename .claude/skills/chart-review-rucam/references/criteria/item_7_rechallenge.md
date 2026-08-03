---
field_id: item_7_rechallenge
prompt: RUCAM Item 7 — response to readministration score (computed)
answer_schema:
  enum: [3, 1, 0, -2]
cardinality: one
group: rucam
role: interpretive
required_note: "COMPUTED from rechallenge_result — not answered directly."
derivation: 'rechallenge_result == "positive_alone" ? 3 : rechallenge_result == "positive_with_codrug" ? 1 : rechallenge_result == "below_uln" ? -2 : 0'
---

# Criterion: item_7_rechallenge (computed)

## Definition

RUCAM Item 7 (response to readministration), **computed** from `rechallenge_result` —
do NOT answer directly:

- **+3** if `positive_alone` (anchor lab doubled on re-exposure to the suspect drug alone).
- **+1** if `positive_with_codrug` (doubled, but a co-medication was also present).
- **−2** if `below_uln` (re-exposed, increase stayed below ULN → negative rechallenge).
- **0** if `none_or_insufficient` (no valid rechallenge / not interpretable).

## Extraction guidance

Answer `rechallenge_result` (per `references/scoring/item-7-rechallenge.md`); this
score derives from it.
