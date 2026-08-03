---
field_id: hachinski_score
prompt: What is the documented Hachinski Ischemic Score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 18
cardinality: one
group: cognitive_scales
---

# Criterion: hachinski_score

## Definition

The documented **Hachinski Ischemic Score** for THIS patient. The Hachinski is a
weighted checklist used to distinguish a **vascular / ischemic** etiology of
cognitive decline from a degenerative (Alzheimer-type) one. Documented range is
an integer **0–18**. A **higher score favors a vascular / ischemic etiology** —
it does **NOT** measure dementia severity. Interpretation (for context only, NOT
for this field): ≤4 favors Alzheimer/degenerative, 5–6 mixed/indeterminate, ≥7
favors vascular/multi-infarct.

## Extraction guidance

Record the **RAW number** documented in this chart and cite the exact note span
containing it. Do **NOT** infer a score from a severity word, and do not confuse
this with a cognition severity scale — a higher Hachinski means *more vascular*,
not *more impaired*. If the chart documents **NO** number for this scale, leave
the answer **null** — do **NOT** write `0`; 0 is a real score (it favors a
degenerative etiology). **Exclude** family history, planned/ordered tests, and
negated mentions.

Scale-specific notes:
- Range is 0–18; **higher favors vascular/ischemic** etiology, not severity.
- If a modified version is stated, still record the stated total as written.

## Examples

- "Hachinski Ischemic Score 8" → `8`
- "Hachinski 2, consistent with a degenerative process" → `2`
- "Hachinski ischemic score of 0" → `0`
- "Hachinski to be calculated pending imaging" → (leave unanswered, do not write 0)
- "no Hachinski documented / testing deferred" → (leave unanswered, do not write 0)
