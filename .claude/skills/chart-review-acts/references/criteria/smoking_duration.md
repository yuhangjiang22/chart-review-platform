---
field_id: smoking_duration
prompt: For how many years has/did the patient smoke?
answer_schema:
  type: integer
  minimum: 0
  maximum: 100
cardinality: one
group: smoking
is_applicable_when: 'smoking_status in ["current", "former"]'
---

# Criterion: smoking_duration

## Definition

The documented **duration of smoking in years** — how many years the patient has
smoked (current smokers) or did smoke (former smokers). This field captures the raw
years-smoked figure stated in the chart.

## Extraction guidance

Record the raw documented number and cite the span. Do NOT compute the duration
yourself: if the chart gives only a start age and a current/quit age and never
states a years-smoked figure, leave this null — do **not** subtract the ages.
Likewise do not infer the duration from pack-years. "Smoked for 40 years" →
`40`; "20-year smoking history" → `20`.

If not documented, leave null (never `0`). These fields are only applicable when
smoking_status is `current` or `former`; if smoking_status is `never` or `unknown`
they are not applicable.

**Evidence:** cite the duration span.

## Examples

- "Smoked for 40 years." → `40`
- "20-year smoking history." → `20`
- "Started smoking in his 20s, now 65 (~45 years)." → `45` (the duration is written)
- "Started smoking at 20, quit at 50." → (leave unanswered — do **not** subtract to get `30`)
- not documented → (leave unanswered)
