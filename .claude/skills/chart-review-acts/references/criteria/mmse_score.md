---
field_id: mmse_score
prompt: What is the documented Mini-Mental State Examination (MMSE) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 30
cardinality: one
group: cognitive_scales
---

# Criterion: mmse_score

## Definition

The documented **Mini-Mental State Examination (MMSE) total score** for THIS
patient. The MMSE is a brief screen of global cognition (orientation,
registration, attention/calculation, recall, language, and visual
construction). Documented range is an integer **0–30**, where **higher = better
cognition**. Interpretation (for context only, NOT for this field): ≥24 normal,
19–23 mild, 10–18 moderate, ≤9 severe.

## Extraction guidance

Record the **RAW number** documented in this chart and cite the exact note span
containing it. Do **NOT** infer a score from a severity word ("severe dementia"
is not a number). If the chart documents **NO** number for this scale, leave the
answer **null** — do **NOT** write `0`; 0 is a real, severe score. **Exclude**
family history, planned/ordered tests, and negated mentions.

Scale-specific notes:
- Range is 0–30; **higher = better** cognition, lower = worse.
- Capture the value as stated even if a note uses a different denominator;
  record the documented numerator total.

## Examples

- "MMSE 26/30" → `26`
- "Mini-Mental State Exam score of 18" → `18`
- "MMSE 4/30, profound global impairment" → `4`
- "MMSE to be repeated at follow-up" → (leave unanswered, do not write 0)
- "no MMSE documented / testing deferred" → (leave unanswered, do not write 0)
