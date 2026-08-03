---
field_id: tics_score
prompt: What is the documented Telephone Interview for Cognitive Status (TICS) score?
answer_schema:
  type: integer
  minimum: 0
  maximum: 41
cardinality: one
group: cognitive_scales
---

# Criterion: tics_score

## Definition

The documented **Telephone Interview for Cognitive Status (TICS) score** for THIS
patient. The TICS is a brief telephone-administered screen of global cognition
used when in-person testing is impractical. Documented range is an integer
**0–41** for the standard form, where **higher = better cognition**.

## Extraction guidance

Record the **RAW number** documented in this chart and cite the exact note span
containing it. Do **NOT** infer a score from a severity word. If the chart
documents **NO** number for this scale, leave the answer **null** — do **NOT**
write `0`; 0 is a real, severe score. **Exclude** family history, planned/ordered
tests, and negated mentions.

Scale-specific notes:
- Standard-form range is 0–41; **higher = better** cognition, lower = worse.
- Capture the value as stated even if a modified form uses a different
  denominator; record the documented total.

## Examples

- "TICS 33" → `33`
- "Telephone Interview for Cognitive Status score of 28/41" → `28`
- "TICS 9, severe impairment" → `9`
- "TICS to be administered by phone next week" → (leave unanswered, do not write 0)
- "no TICS documented / testing deferred" → (leave unanswered, do not write 0)
