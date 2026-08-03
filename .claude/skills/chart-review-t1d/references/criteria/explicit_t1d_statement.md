---
field_id: explicit_t1d_statement
prompt: Does any provider explicitly state the patient has type 1 diabetes?
answer_schema:
  enum: [yes, no_info]
cardinality: one
group: longitudinal
---

# Criterion: explicit_t1d_statement

## Definition

Whether **any** provider explicitly states, in narrative text, that the patient has
**type 1 diabetes** (as opposed to only a code). Feeds the longitudinal panel.

## Extraction guidance

**Always commit one value:**

- **`yes`** — a note contains an explicit T1D statement for this patient ("patient
  with type 1 diabetes", "T1DM", "insulin-dependent diabetes, type 1").
- **`no_info`** — no explicit narrative T1D statement (codes alone do not count
  here).

Exclude family history and negations. Cite the note span.

## Examples

- "42-year-old with type 1 diabetes on pump" → `yes`
- Only `E10.9` codes, no narrative type statement → `no_info`
- "Mother has type 1 diabetes" → `no_info` (family history)
