---
field_id: phg_bleed_365d
prompt: Portal hypertensive gastropathy bleeding — grade the most recent documented event, ANY date (graded)?
answer_schema:
  enum: [definite, highly_likely, probable, none]
cardinality: one
group: decompensation
---

# Decompensation: portal hypertensive gastropathy (PHG) bleeding (event grading, windowless)

## Definition
PHG bleeding per the LCN operational definitions. Grade with the paper's tiers and commit the HIGHEST tier satisfied; if the
event is mentioned but no tier's definition is fully satisfied, answer `none`
and explain in the rationale. Grade the MOST RECENT documented event at ANY date — do NOT apply any time
window; the outcome scanner owns all window logic (see FORWARD-SCAN SEMANTICS
in SKILL.md). The `365d` in the field name is historical; the grading itself
is WINDOWLESS. In particular, never dismiss an event as 'outside the index
window' — that reasoning produced a confirmed false positive (a 2021 ascites
wave dismissed because a 2015 index was used as the anchor).

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
- **`none`** - no tier satisfied anywhere in the chart.

## Examples
- "Melena; EGD: severe PHG with oozing" -> `definite`
- "Hgb drop 2.5; EGD: moderate mosaic pattern, no varix bleeding" -> `probable`
- "Mild PHG noted incidentally" -> `none`
