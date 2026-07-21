---
field_id: quit_time
prompt: In what calendar YEAR did the patient quit smoking? Answer with the 4-digit year only. Use the cessation year itself — never a note/encounter/entry or last-updated timestamp. If the chart gives only an age-at-quit or a relative time (no explicit year), leave unanswered.
answer_schema:
  type: string
cardinality: one
group: smoking
is_applicable_when: 'smoking_status == "former"'
---

# Criterion: quit_time

## Definition

The documented **calendar year of smoking cessation** — the year the patient quit
smoking — as an explicit 4-digit year (e.g. `2008`). Only an explicitly documented
year counts; an age-at-quit or a relative expression is **not** a date and is not
extracted here.

## Extraction guidance

Record the documented cessation **year** and cite the span:

- "quit in 2015" → `2015`
- "stopped smoking, 2008" → `2008`

**Dates only.** Do NOT extract, convert, or compute a year from:

- an **age at quit** ("quit at age 55") — leave unanswered;
- a **relative time** ("quit 10 years ago", "quit a decade ago") — do NOT subtract
  from the note date; leave unanswered;
- the note/encounter date or a last-updated timestamp.

If no explicit cessation **year** is documented, leave null. This field applies only
to FORMER smokers (a current smoker has not quit; a never-smoker has no cessation
year).

**Evidence:** cite the span containing the cessation year.

## Examples

- "Quit smoking in 2008." → `2008`
- "Cessation year: 2015." → `2015`
- "Quit at age 55." → (leave unanswered — age, not a year)
- "Stopped smoking 10 years ago." → (leave unanswered — relative, not a year)
- "Former smoker, quit date not recorded." → (leave unanswered)
- not documented → (leave unanswered)
