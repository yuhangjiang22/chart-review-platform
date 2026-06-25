---
field_id: pack_per_day
prompt: How many packs of cigarettes per day does/did the patient smoke?
answer_schema:
  type: number
  minimum: 0
  maximum: 20
cardinality: one
group: smoking
is_applicable_when: 'smoking_status in ["current", "former"]'
---

# Criterion: pack_per_day

## Definition

The documented number of **packs of cigarettes smoked per day** (may be a decimal).
This field captures the raw packs/day figure stated in the chart.

## Extraction guidance

Record the raw documented number and cite the span; do NOT compute pack-years
yourself. "1 pack per day" → `1`; "0.5 ppd" → `0.5`; "two packs daily" → `2`.

If not documented, leave null (never `0`). These fields are only applicable when
smoking_status is `current` or `former`; if smoking_status is `never` or `unknown`
they are not applicable.

**Evidence:** cite the packs-per-day span.

## Examples

- "1 pack per day." → `1`
- "0.5 ppd." → `0.5`
- "Two packs daily." → `2`
- not documented → (leave unanswered)
