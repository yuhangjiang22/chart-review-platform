---
field_id: c_peptide_result
prompt: What is the documented C-peptide finding for this patient?
answer_schema:
  enum: [low, normal, high, not_measured]
cardinality: one
group: labs
---

# Criterion: c_peptide_result

## Definition

The patient's documented **C-peptide** finding (fasting or stimulated). A low
value supports T1D (Klompas signal). The threshold for `low` is **`< 0.8 ng/mL`**
after verifying units.

## Extraction guidance

**Always commit one value:**

- **`low`** — the documented C-peptide is **`< 0.8 ng/mL`** (verify the units
  match; convert or defer to `not_measured` if units are unclear).
- **`normal`** — within the reference range (roughly 0.8–3.1 ng/mL, per the note's
  range).
- **`high`** — above the reference range.
- **`not_measured`** — no C-peptide result documented.

Read `measurements` (OMOP) for the value + unit + reference range and preserve the
exact value in the evidence/rationale (cite the measurement `row_id`). If the value
is present but its **units are ambiguous** (e.g. nmol/L vs ng/mL), do not guess a
band — record `not_measured` and flag it in the rationale.

## Examples

- "C-peptide 0.4 ng/mL (ref 0.8–3.1)" → `low`
- "C-peptide 1.9 ng/mL" → `normal`
- "C-peptide 4.5 ng/mL" → `high`
- No C-peptide result → `not_measured`
- "C-peptide 0.3 nmol/L" with no ng/mL conversion given → `not_measured` (flag units)
