---
field_id: glp1_indication_documented
prompt: Is the indication for the GLP-1 receptor agonist documented?
answer_schema:
  enum: [yes, no_info]
cardinality: one
group: longitudinal
---

# Criterion: glp1_indication_documented

## Definition

Whether the **indication** for a GLP-1 receptor agonist is documented (e.g. type 2
diabetes, weight management, cardiovascular risk reduction). Helps interpret a
recent T2D-coding shift near a GLP-1 start.

## Extraction guidance

**Always commit one value:**

- **`yes`** — a GLP-1 is documented AND its indication is stated (diabetes, weight,
  CV risk).
- **`no_info`** — no GLP-1 documented, or GLP-1 present with no stated indication.

Cite the note span or the drug row with its indication.

## Examples

- "Started semaglutide for weight management" → `yes`
- "Dulaglutide for type 2 diabetes" → `yes`
- GLP-1 on med list with no indication text → `no_info`
- No GLP-1 → `no_info`
