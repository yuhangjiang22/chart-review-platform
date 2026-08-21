---
field_id: phg_bleed_365d
prompt: Portal hypertensive gastropathy bleeding within 365 days of index (graded)?
answer_schema:
  enum: [definite, highly_likely, probable, none]
cardinality: one
group: decompensation
---

# Decompensation: portal hypertensive gastropathy (PHG) bleeding (365-day lookback)

## Definition
PHG bleeding per the LCN operational definitions. Grade with the paper's tiers and commit the HIGHEST tier satisfied; if the
event is mentioned but no tier's definition is fully satisfied, answer `none`
and explain in the rationale. The event must be **within 365 days before index
or present at index**.

## Tiers (paper's definitions)
- **`definite`**: hematemesis and/or melena AND endoscopy within 24h showing a
  moderate/severe mosaic-like pattern (e.g. discrete cherry-red spots and/or
  diffuse hemorrhagic gastropathy) WITH active bleeding/oozing.
- **`highly_likely`**: hematemesis and/or melena AND endoscopy within 24h
  showing a moderate/severe mosaic-like pattern WITHOUT evidence of variceal
  bleeding.
- **`probable`**: >2 g/dL hemoglobin drop from baseline OR iron deficiency, AND
  endoscopy within 24h showing a moderate/severe mosaic-like pattern without
  evidence of variceal bleeding.
- **`none`** - no tier satisfied in the window.

## Examples
- "Melena; EGD: severe PHG with oozing" -> `definite`
- "Hgb drop 2.5; EGD: moderate mosaic pattern, no varix bleeding" -> `probable`
- "Mild PHG noted incidentally" -> `none`
