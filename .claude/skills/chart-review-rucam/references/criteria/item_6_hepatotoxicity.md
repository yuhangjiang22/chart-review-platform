---
field_id: item_6_hepatotoxicity
prompt: RUCAM Item 6 — prior hepatotoxicity knowledge score (computed)
answer_schema:
  enum: [2, 1, 0]
cardinality: one
group: rucam
role: interpretive
required_note: "COMPUTED from hepatotoxicity_class — not answered directly."
derivation: 'hepatotoxicity_class == "labeled" ? 2 : hepatotoxicity_class == "probable" ? 1 : 0'
---

# Criterion: item_6_hepatotoxicity (computed)

## Definition

RUCAM Item 6 (prior hepatotoxicity knowledge), **computed** from `hepatotoxicity_class`
— do NOT answer directly:

- **+2** if `labeled` (LiverTox category A — reaction labeled / well known).
- **+1** if `probable` (category B — published case reports, not labeled).
- **0** if `none` (category C/D/E or not listed).

## Extraction guidance

Answer `hepatotoxicity_class` via `get_hepatotoxicity_category(<suspect drug>)`; this
score derives from it.
