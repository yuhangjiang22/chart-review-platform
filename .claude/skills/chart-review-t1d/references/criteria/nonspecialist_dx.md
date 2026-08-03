---
field_id: nonspecialist_dx
prompt: What diabetes type does a non-specialist provider document?
answer_schema:
  enum: [t1d, t2d, none]
cardinality: one
group: provider_dx
---

# Criterion: nonspecialist_dx

## Definition

The diabetes type a **non-specialist provider** (primary care, hospitalist, etc.)
documents. This is the **fallback** signal in the ground-truth sequence (step 5),
used only when the endocrinology diagnosis and the objective/treatment criteria do
not resolve the type.

## Extraction guidance

**Always commit one value:**

- **`t1d`** — a non-specialist note explicitly documents type 1.
- **`t2d`** — a non-specialist note explicitly documents type 2.
- **`none`** — no non-specialist type statement.

Use the predominant / most recent explicit non-specialist statement. When
non-specialist notes conflict, record the conflict in the rationale (it flags for
adjudication). This field is lower priority than `endo_provider_dx`.

## Examples

- PCP progress note: "Type 1 diabetic, on pump" → `t1d`
- Hospitalist H&P: "Type 2 DM" → `t2d`
- No explicit type in any non-specialist note → `none`
