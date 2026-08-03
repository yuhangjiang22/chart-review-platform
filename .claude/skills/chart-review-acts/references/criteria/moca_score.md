---
field_id: moca_score
prompt: What is the documented Montreal Cognitive Assessment (MoCA) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 30
cardinality: one
group: cognitive_scales
---

# Criterion: moca_score

## Definition

The documented **Montreal Cognitive Assessment (MoCA) total score** for THIS
patient. The MoCA is a brief screen of global cognition (attention, executive
function, memory, language, visuospatial skills, abstraction, and orientation).
Documented range is an integer **0–30**, where **higher = better cognition**.
Interpretation (for context only, NOT for this field): ≥26 normal, 18–25 mild,
10–17 moderate, 0–9 severe.

## Extraction guidance

Record the **RAW number** documented in this chart and cite the exact note span
containing it. Do **NOT** infer a score from a severity word ("moderate
impairment" is not a number). If the chart documents **NO** number for this
scale, leave the answer **null** — do **NOT** write `0`; 0 is a real, severe
score. **Exclude** family history, planned/ordered tests, and negated mentions.

Scale-specific notes:
- Range is 0–30; **higher = better** cognition, lower = worse.
- Apply the official **+1 education adjustment** only if the note states the
  adjusted score; otherwise record the raw score as written.
- Capture the value as stated even if a note uses a different denominator;
  record the documented numerator total.

## Examples

- "MoCA 21/30" → `21`
- "Montreal Cognitive Assessment score 26" → `26`
- "MoCA 0/30, unable to complete most items" → `0`
- "MoCA ordered for next visit" → (leave unanswered, do not write 0)
- "no MoCA documented / testing deferred" → (leave unanswered, do not write 0)
