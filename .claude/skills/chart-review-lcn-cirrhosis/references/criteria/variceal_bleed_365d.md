---
field_id: variceal_bleed_365d
prompt: Variceal hemorrhage within 365 days of index (graded)?
answer_schema:
  enum: [definite, highly_likely, probable, none]
cardinality: one
group: decompensation
---

# Decompensation: variceal hemorrhage (365-day lookback)

## Definition
Variceal bleeding per the LCN operational definitions. Grade with the paper's tiers and commit the HIGHEST tier satisfied; if the
event is mentioned but no tier's definition is fully satisfied, answer `none`
and explain in the rationale. The event must be **within 365 days before index
or present at index**.

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
- **`none`** - no tier satisfied in the window.

## Examples
- "EGD: actively oozing esophageal varix, banded" -> `definite`
- "Melena; EGD (same admission, <24h): red wale signs, no other source" -> `highly_likely`
- "EGD: grade II varices, no stigmata; no bleeding history" -> `none`
