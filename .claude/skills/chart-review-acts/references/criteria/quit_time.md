---
field_id: quit_time
prompt: When did the patient quit smoking (year, age at quit, or relative time)? Use the cessation time itself — never a note/encounter/entry or last-updated timestamp.
answer_schema:
  type: string
cardinality: one
group: smoking
is_applicable_when: 'smoking_status == "former"'
---

# Criterion: quit_time

## Definition

The documented **time of smoking cessation** — when the patient quit smoking —
captured as a free-text expression. It may be a calendar year ("2008"), an age at
quit ("age 55"), or a relative time ("10 years ago").

## Extraction guidance

Record the documented cessation expression verbatim and cite the span: a calendar
year ("quit in 2015" → `2015`), an age at quit ("quit at age 55" → `age 55`), or a
relative time ("quit 10 years ago" → `10 years ago`). Do not normalize or convert
between formats — record what the chart says.

This field applies only to FORMER smokers (a current smoker has not quit, and a
never-smoker has no cessation date). If not documented, leave null.

**Evidence:** cite the quit-time span.

## Examples

- "Quit smoking in 2008." → `2008`
- "Quit at age 55." → `age 55`
- "Stopped smoking 10 years ago." → `10 years ago`
- "Former smoker, quit date not recorded." → (leave unanswered)
- not documented → (leave unanswered)
