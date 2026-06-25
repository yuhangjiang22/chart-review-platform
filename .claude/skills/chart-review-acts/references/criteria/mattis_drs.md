---
field_id: mattis_drs
prompt: What is the documented Mattis Dementia Rating Scale (DRS-2) total score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 144
cardinality: one
group: cognitive_scales
---

# Criterion: mattis_drs

## Definition

The documented **Mattis Dementia Rating Scale (DRS-2) total score** for THIS
patient. The Mattis DRS-2 assesses cognition across five subscales (attention,
initiation/perseveration, construction, conceptualization, and memory).
Documented range is an integer **0–144**, where **higher = better cognition**.
There is no single universal cutoff; the score is interpreted against version
plus age/education norms (do not apply a threshold here — record the raw value).

## Extraction guidance

Record the **RAW number** documented in this chart and cite the exact note span
containing it. Do **NOT** infer a score from a severity word. If the chart
documents **NO** number for this scale, leave the answer **null** — do **NOT**
write `0`; 0 is a real, severe score. **Exclude** family history, planned/ordered
tests, and negated mentions.

Scale-specific notes:
- Range is 0–144; **higher = better** cognition, lower = worse.
- Record the total as stated; capture the numerator total even when a
  subscale or denominator is also written.

## Examples

- "DRS-2 132/144" → `132`
- "Mattis Dementia Rating Scale total 105" → `105`
- "Mattis DRS-2 total 18/144" → `18`
- "Mattis DRS-2 planned for the next neuropsych visit" → (leave unanswered, do not write 0)
- "no Mattis DRS documented / testing deferred" → (leave unanswered, do not write 0)
