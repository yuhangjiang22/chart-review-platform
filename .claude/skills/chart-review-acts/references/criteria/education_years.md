---
field_id: education_years
prompt: How many years of formal education has the patient completed?
answer_schema:
  type: integer
  minimum: 0
  maximum: 40
cardinality: one
group: demographics
---

# Criterion: education_years

## Definition

The patient's **years of formal education completed**, recorded as an integer
(range **0–30**). This is a count of years of schooling, used as a cognitive
reserve / demographic covariate — not a degree level or grade name. Higher values
mean more years of formal education.

## Extraction guidance

Record the **RAW number documented** and cite the exact note span. Capture the
documented years of schooling (e.g., "12 years"). A degree phrase may be used
**only if the note states the equivalent number** (e.g., "college graduate ≈ 16
years" counts only because the note gives the year count). Do **NOT** infer or
guess years from a degree, grade, or credential alone ("college graduate", "high
school", "GED") when no number is stated. If **NO number is documented**, leave
the answer **null** (do **NOT** write `0`). Exclude family history,
planned/ordered, and negated mentions.

## Examples

- "12 years of education." → `12`
- "Completed 16 years of formal schooling (college graduate)." → `16`
- "8th-grade education; 8 years completed." → `8`
- "College graduate." → (leave unanswered, not 0)
- "not documented" → (leave unanswered, not 0)

**Evidence:** cite the span.
