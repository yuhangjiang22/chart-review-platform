---
field_id: autoantibody_result
prompt: What is the documented diabetes autoantibody result for this patient?
answer_schema:
  enum: [positive, negative, borderline, not_tested]
cardinality: one
group: labs
---

# Criterion: autoantibody_result

## Definition

The patient's documented **diabetes-associated autoantibody** result — GAD65 /
GADA, IA-2 / ICA512, ZnT8, or insulin autoantibody (IAA) / islet cell antibody. A
definitive positive supports T1D (Klompas signal).

## Extraction guidance

**Always commit one value:**

- **`positive`** — a **definitive positive** result for any diabetes autoantibody.
- **`negative`** — tested and negative. A negative does **not** exclude T1D; it is
  recorded but does not by itself change the classification.
- **`borderline`** — indeterminate/equivocal/near-cutoff result that cannot be
  called positive or negative.
- **`not_tested`** — no autoantibody result documented after checking `measurements`
  and notes.

Read `measurements` (OMOP) for the analyte + value + reference range; preserve the
exact result in the evidence/rationale. A **panel order without a result** →
`not_tested` (do not infer positivity from an order). If multiple antibodies
conflict, `positive` if any is definitively positive.

## Examples

- "GAD65 antibody 250 U/mL (positive, ref <5)" → `positive`
- "Islet cell antibodies negative" → `negative`
- "ZnT8 borderline, repeat advised" → `borderline`
- "GAD panel ordered" (no result) → `not_tested`
