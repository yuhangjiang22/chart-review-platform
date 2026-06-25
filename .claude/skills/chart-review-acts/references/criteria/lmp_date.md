---
field_id: lmp_date
prompt: What is the documented last menstrual period (LMP) date or time expression?
answer_schema:
  type: string
cardinality: one
group: reproductive
---

# Criterion: lmp_date

## Definition

The documented **last menstrual period (LMP)** — the date or time expression
stating **when** the patient's last menstruation occurred, recorded as one
free-text value. This is a span extraction, not a binary label. If no LMP is
documented, leave it **unanswered** (null). (Per the ACTS Menstruation
Extraction guideline, Part 2.)

## Extraction guidance

Extract the **date/time EXPRESSION ONLY**, not the surrounding label words:
"LMP: 05/10/2026" → `05/10/2026`. Acceptable forms:

- **Explicit calendar dates** — `05/10/2026`, `5/10/26`.
- **Month / year** — `January 2025`.
- **Relative time expressions tied to the LMP** — `two weeks ago`, `3 months
  ago`.

If multiple LMP mentions appear, take the one designated as the **most recent /
last** menstrual period.

**Do NOT** record:
- An **age of menopause** as an LMP — "menopause at age 51" is an age, NOT a
  documented LMP (leave the LMP unanswered even though postmenopause is true).
- **Family history** ("mother entered menopause at age 45") — not the patient.
- **Educational discussion or planned evaluations** ("discussed menopause
  symptoms", "gynecology referral for menstrual concerns") — not a documented
  date.

**Evidence:** cite the span containing the LMP date/time.

## Examples

- "LMP: 05/10/2026." → `05/10/2026`
- "Last menstrual period was two weeks ago." → `two weeks ago`
- "Last menses occurred in January 2025." → `January 2025`
- "Postmenopausal female. Menopause at age 51." → (unanswered) (an age is not an LMP)
- "Mother entered menopause at age 45." → (unanswered) (family history)
