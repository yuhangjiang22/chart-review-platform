---
field_id: first_glp1_date
prompt: What is the documented date of first GLP-1 receptor agonist use?
answer_schema:
  type: string
cardinality: one
group: longitudinal
---

# Criterion: first_glp1_date

## Definition

The **earliest** documented date the patient was on a GLP-1 receptor agonist
(e.g. semaglutide, dulaglutide, liraglutide, tirzepatide). Relevant because a
recent T2D-coding shift near a GLP-1 start may reflect GLP-1 use rather than a true
type reclassification.

## Extraction guidance

- Report an ISO date **`YYYY-MM-DD`** (first GLP-1 order/administration).
- Leave **blank/unanswered** if no GLP-1 is documented.
- Cite the earliest GLP-1 `drugs` row or the note span.

## Examples

- First semaglutide order dated 2024-02-10 → `2024-02-10`
- No GLP-1 documented → (leave blank)
