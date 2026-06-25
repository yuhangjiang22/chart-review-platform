---
field_id: cornell_csdd
prompt: What is the documented Cornell Scale for Depression in Dementia (CSDD) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 38
cardinality: one
group: depression_scales
---

# Criterion: cornell_csdd

## Definition

The documented **Cornell Scale for Depression in Dementia (CSDD)** total score
for THIS patient — a clinician-rated instrument for assessing depression in
patients with dementia, combining caregiver interview and direct patient
observation. The total ranges **0–38**, where a higher score means more
depression. For context only (not a substitute for the raw number): <6 suggests
absence of significant symptoms, >10 a probable major depressive episode, >18 a
definite major depressive episode.

## Extraction guidance

Record the **RAW number documented** and cite the exact note span. Do **NOT**
infer the score from a severity or mood word ("probable depression", "appears
sad") — capture only an explicit numeric total. If **NO number is documented**,
leave the answer **null** (do **NOT** write `0`). Exclude family history,
planned/ordered ("CSDD planned"), and negated mentions ("CSDD not done").

The interpretation bands above are context only; record the documented integer,
not a band label. If only a band or qualitative statement is documented without
a number, leave the answer null.

## Examples

- "Cornell Scale for Depression in Dementia total 14." → `14`
- "CSDD 7/38." → `7`
- "Cornell score of 21, consistent with major depression." → `21`
- "CSDD suggested probable depression." → (leave unanswered, not 0)
- "not documented" → (leave unanswered, not 0)

**Evidence:** cite the score span.
