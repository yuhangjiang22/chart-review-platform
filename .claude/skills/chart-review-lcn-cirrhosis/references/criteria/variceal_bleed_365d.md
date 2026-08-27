---
field_id: variceal_bleed_365d
prompt: Variceal hemorrhage — grade the most recent documented event, ANY date (graded)?
answer_schema:
  enum: [definite, highly_likely, probable, none]
cardinality: one
group: decompensation
---

# Decompensation: variceal hemorrhage (event grading, windowless)

## Definition
Variceal bleeding per the LCN operational definitions. Grade with the paper's tiers and commit the HIGHEST tier satisfied; if the
event is mentioned but no tier's definition is fully satisfied, answer `none`
and explain in the rationale. Grade the MOST RECENT documented event at ANY date — do NOT apply any time
window; the outcome scanner owns all window logic (see FORWARD-SCAN SEMANTICS
in SKILL.md). The `365d` in the field name is historical; the grading itself
is WINDOWLESS. In particular, never dismiss an event as 'outside the index
window' — that reasoning produced a confirmed false positive (a 2021 ascites
wave dismissed because a 2015 index was used as the anchor).

## Tiers (paper's definitions)
- **`definite`**: spurting or oozing of an esophageal, gastric, or ectopic
  varix on endoscopy - OR - hematemesis and/or melena AND endoscopy within 24h
  of admission demonstrating signs of recent bleeding ("white nipple" sign
  and/or clot over a varix).
- **`highly_likely`**: hematemesis and/or melena AND endoscopy within 24h
  demonstrating red wale markings on varices without another potential source.
- **`probable`**: hematemesis and/or melena and/or >2 g/dL hemoglobin drop from
  baseline AND endoscopy within 24h demonstrating blood in the stomach with
  varices as the only potential source.
- **`none`** - no tier satisfied anywhere in the chart.

## Operational details (v2 ops 11-12)
- **Hemoglobin drop** = >2 g/dL within a ROLLING 48 HOURS - not versus a
  long-lookback baseline (chronic anemia is not a bleed).
- **"No other potential source"** - competing sources to screen for: peptic
  ulcer, Mallory-Weiss tear, erosive esophagitis, malignancy, Dieulafoy
  lesion, angiodysplasia.

## Interpretation note (v2 op 6)
Only `definite` counts toward the decompensation verdict (portal-hypertensive
bleeding tier per the registry); extract the true tier regardless - the
derivation applies the rule.

## Examples
- "EGD: actively oozing esophageal varix, banded" -> `definite`
- "Melena; EGD (same admission, <24h): red wale signs, no other source" -> `highly_likely`
- "EGD: grade II varices, no stigmata; no bleeding history" -> `none`
