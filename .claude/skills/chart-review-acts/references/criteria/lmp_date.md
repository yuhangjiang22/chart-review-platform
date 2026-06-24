---
field_id: lmp_date
prompt: What is the documented last menstrual period (LMP) date or time expression?
answer_schema:
  type: string
cardinality: one
group: reproductive
---

# Criterion: lmp_date

The documented **last menstrual period** as a date or time expression — extract
the date/time EXPRESSION ONLY, not the label words: "LMP: 05/10/2026" → `05/10/2026`;
"LMP two weeks ago" → `two weeks ago`. If multiple, take the most recent.

**Do NOT** record an age of menopause as an LMP ("menopause at age 51" is NOT an
LMP). Exclude family history and planned evaluations. If no LMP is documented,
leave unanswered.

**Evidence:** cite the LMP span.
