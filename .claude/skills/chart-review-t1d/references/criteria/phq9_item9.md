---
field_id: phq9_item9
prompt: What is the documented PHQ-9 item 9 (self-harm) response?
answer_schema:
  enum: [positive, negative, not_documented]
cardinality: one
group: surveys
---

# Criterion: phq9_item9

## Definition

The PHQ-9 **item 9** response (thoughts of self-harm / being better off dead),
recorded **separately** from the total because a positive response triggers the
study/site **safety process**.

## Extraction guidance

**Always commit one value:**

- **`positive`** — item 9 is documented as any non-zero / affirmative response
  (thoughts present, "several days"/"more than half"/"nearly every day"). **Flag
  the safety process** in the rationale.
- **`negative`** — item 9 documented as 0 / "not at all".
- **`not_documented`** — no PHQ-9, or item-level responses not available.

Record the item-9 value only from documented item-level data; do not infer it from
the total. Cite the row/span.

## Examples

- "Item 9: nearly every day" → `positive` (trigger safety process)
- "Item 9: not at all" → `negative`
- PHQ-9 total only, no item breakdown → `not_documented`
