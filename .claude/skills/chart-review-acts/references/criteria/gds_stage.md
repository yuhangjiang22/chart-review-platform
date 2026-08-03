---
field_id: gds_stage
prompt: What is the documented Global Deterioration Scale (GDS) stage?
answer_schema:
  enum: ["1", "2", "3", "4", "5", "6", "7"]
cardinality: one
group: staging
---

# Criterion: gds_stage

## Definition

The documented **Reisberg Global Deterioration Scale (GDS) stage** for this
patient — a 1–7 staging of cognitive decline where higher = greater
deterioration: `1` no cognitive decline (normal), `2` very mild decline, `3` mild
decline, `4` moderate decline, `5` moderately severe decline, `6` severe decline,
`7` very severe decline (very severe dementia). This is the Reisberg staging
scale, NOT the Geriatric Depression Scale (that is `gds_depression_score`).

## Extraction guidance

Record the documented GDS stage value exactly as stated (e.g. "GDS stage 4" →
`4`). Do NOT convert from a different scale (e.g. do NOT derive a GDS stage from a
CDR, MMSE, or MoCA value). Confirm it is the Reisberg Global Deterioration Scale
and not the Geriatric Depression Scale before recording. If no GDS stage is
documented, leave null.

**Evidence:** cite the stage span.

## Examples

- "GDS stage 1" / "no cognitive decline" → `1` (normal)
- "GDS 3" / "mild cognitive decline, GDS stage 3" → `3` (mild decline)
- "GDS stage 4" → `4` (moderate decline)
- "Reisberg GDS 6" → `6` (severe decline)
- "GDS stage 7, very severe dementia" → `7` (very severe)
- "GDS (geriatric depression) score 5" → null (that is the depression scale, not
  the Reisberg stage)
