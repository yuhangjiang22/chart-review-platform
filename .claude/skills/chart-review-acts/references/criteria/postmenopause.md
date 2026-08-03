---
field_id: postmenopause
prompt: Is the patient documented as postmenopausal / having undergone menopause?
answer_schema:
  enum:
    - "1"
    - "0"
cardinality: one
group: reproductive
---

# Criterion: postmenopause

## Definition

Whether the chart documents that the patient is **postmenopausal** — has
permanently ceased menstruation / undergone menopause. Use only explicitly
documented information about the patient.

Two answers: **`1`** (postmenopausal documented) or **`0`** (no evidence the
patient is postmenopausal / not addressed).

## Extraction guidance

Assign **`1`** when the note documents postmenopausal status or menopause:
- "postmenopausal" / "post-menopausal" / "postmenopausal female"
- "history of menopause", "natural menopause", "surgical menopause"
- "menopause at age 50" / "menopause occurred at age 52"

Assign **`0`** when there is no documentation that the patient is postmenopausal
(including premenopausal/perimenopausal status, or the topic not addressed).

**Evidence:** cite the SMALLEST affirmative span ("Patient is postmenopausal.",
"History of surgical menopause."). For `0`, cite the section checked
(GYN/repro history, HPI) or note it is not addressed.

## Examples

- "Patient is postmenopausal." → `1`
- "Menopause occurred at age 52." → `1`
- "History of surgical menopause." → `1`
- "Premenopausal, regular cycles." → `0`
- Reproductive status not addressed → `0`
