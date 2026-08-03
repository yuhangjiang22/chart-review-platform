---
field_id: endo_provider_dx
prompt: What diabetes type does an endocrinology provider explicitly document?
answer_schema:
  enum: [t1d, t2d, none]
cardinality: one
group: provider_dx
---

# Criterion: endo_provider_dx

## Definition

The diabetes type an **endocrinology provider** explicitly documents for this
patient. This is the highest-priority signal in the ground-truth sequence (step 1):
an endocrinologist's explicit type call wins.

## Extraction guidance

**Always commit one value:**

- **`t1d`** — an endocrinology/diabetology note explicitly documents **type 1**.
- **`t2d`** — an endocrinology note explicitly documents **type 2**.
- **`none`** — no endocrinology-provider type statement (no endo note, or the endo
  note does not state a type).

Require that the author is an endocrinology/diabetology provider AND that the type
is explicit. A code alone in a non-endo encounter does not count here (that flows
through the code counts). If endo notes conflict, prefer the most recent explicit
statement and note the conflict in the rationale.

## Examples

- Endocrinology consult: "Assessment: Type 1 diabetes mellitus" → `t1d`
- Endo note: "Type 2 DM, insulin-requiring" → `t2d`
- Only PCP notes, no endocrinology involvement → `none`
