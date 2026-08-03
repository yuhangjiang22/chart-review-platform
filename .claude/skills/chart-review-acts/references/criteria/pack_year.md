---
field_id: pack_year
prompt: What is the patient's documented cumulative smoking exposure in pack-years?
answer_schema:
  type: number
  minimum: 0
  maximum: 150
cardinality: one
group: smoking
is_applicable_when: 'smoking_status in ["current", "former"]'
---

# Criterion: pack_year

## Definition

The documented **cumulative pack-year** smoking exposure (1 pack-year = 1 pack/day
× 1 year). This field captures the raw pack-year figure stated in the chart, not a
value you calculate.

## Extraction guidance

Record the raw documented number and cite the span; do NOT compute pack-years
yourself. "30 pack-year history" → `30`; if the chart only states packs/day and
years separately ("1 ppd for 22.5 years") and never gives a pack-year figure, leave
this null — do not multiply.

If not documented, leave null (never `0`). These fields are only applicable when
smoking_status is `current` or `former`; if smoking_status is `never` or `unknown`
they are not applicable.

**Evidence:** cite the pack-year span.

## Examples

- "30 pack-year history." → `30`
- "Smoking: 45 pack years." → `45`
- "0.5 ppd × 20 years (10 pack-years)." → `10`
- "1 ppd for 22.5 years." → (leave unanswered — no pack-year figure stated)
- not documented → (leave unanswered)
