---
field_id: gds_depression_score
prompt: What is the documented Geriatric Depression Scale score? Use ONLY a score explicitly labeled Geriatric Depression Scale / GDS / GDS-15 / GDS-30. Do NOT use PHQ-9, PHQ-2, or any other depression screen; if only a non-GDS screen is documented, omit this field.
answer_schema:
  type: integer
  minimum: 0
  maximum: 30
cardinality: one
group: depression_scales
---

# Criterion: gds_depression_score

## Definition

The documented **Geriatric Depression Scale (GDS)** total score for THIS patient
— a self-report screen for depressive symptoms in older adults, where a higher
score means more depressive symptoms. Two common forms exist: **GDS-15** (range
**0–15**) and the long form **GDS-30** (range **0–30**). This field records the
raw integer as written; note the version in the rationale when the chart states
it. This is NOT the Global Deterioration Scale (a dementia-staging instrument,
captured separately as `gds_stage`).

## Extraction guidance

Record the **RAW number documented** and cite the exact note span. Do **NOT**
infer the score from a severity or mood word ("mildly depressed", "low mood",
"euthymic" → no number). If **NO number is documented**, leave the answer
**null** (do **NOT** write `0`). Exclude family history, planned/ordered
("GDS to be administered next visit"), and negated mentions ("GDS not
performed").

When the form is stated (GDS-15 vs GDS-30), record it in the rationale so the
0–15 vs 0–30 range is unambiguous. Take care not to confuse the GDS depression
score with the Global Deterioration Scale stage — only the depression-screen
total belongs here.

## Examples

- "GDS-15 score 9/15." → `9`
- "Geriatric Depression Scale: 22 (long form)." → `22`
- "GDS 4." → `4`
- "Patient appears mildly depressed." → (leave unanswered, not 0)
- "not documented" → (leave unanswered, not 0)

**Evidence:** cite the score span.
