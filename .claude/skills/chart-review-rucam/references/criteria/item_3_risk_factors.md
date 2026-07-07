---
field_id: item_3_risk_factors
prompt: RUCAM Item 3 — risk factors score (computed)
answer_schema:
  enum: [2, 1, 0]
cardinality: one
group: rucam
role: interpretive
required_note: "COMPUTED from rf_alcohol, rf_pregnancy, rf_age_ge_55, and injury_track — not answered directly."
derivation: '(((rf_alcohol == "yes") OR (injury_track != "hepatocellular" AND rf_pregnancy == "yes")) ? 1 : 0) + ((rf_age_ge_55 == "yes") ? 1 : 0)'
---

# Criterion: item_3_risk_factors (computed)

## Definition

RUCAM Item 3 (host risk factors), **computed** from its sub-facts — do NOT answer
this directly:

- **+1 alcohol factor** — `rf_alcohol` = yes, **or** (on the cholestatic/mixed track
  only) `rf_pregnancy` = yes.
- **+1 age factor** — `rf_age_ge_55` = yes.

Pregnancy contributes only when `injury_track` is not `hepatocellular`. The score is
`0`, `1`, or `2`. To change it, fix the sub-facts and it recomputes; if any sub-fact
is missing it stays **Pending** (never a fabricated score).

## Extraction guidance

Do not answer this field. Answer the sub-facts instead — `rf_alcohol`,
`rf_pregnancy`, `rf_age_ge_55`, `injury_track` (per `references/scoring/item-3-risk-factors.md`)
— and this score is derived from them.
