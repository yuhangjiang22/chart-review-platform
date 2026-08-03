---
field_id: noninsulin_med
prompt: What non-insulin diabetes medication use is documented for this patient?
answer_schema:
  enum: [none, metformin_only, other, no_info]
cardinality: one
group: medications
---

# Criterion: noninsulin_med

## Definition

The patient's documented **non-insulin diabetes medication** use. Drives Klompas
criterion 2 (>50% T1D codes **and** no non-insulin med other than metformin).
Classes: biguanide (metformin), GLP-1 receptor agonist, SGLT2 inhibitor, DPP-4
inhibitor, sulfonylurea, TZD, etc.

## Extraction guidance

**Always commit one value:**

- **`none`** — no non-insulin diabetes medication documented (med history is
  complete enough to say so).
- **`metformin_only`** — the only non-insulin diabetes med is metformin.
- **`other`** — any non-insulin diabetes med besides metformin is documented
  (GLP-1, SGLT2, DPP-4, sulfonylurea, TZD), alone or with metformin.
- **`no_info`** — the non-insulin medication history cannot be established.

Read `drugs` (OMOP) first. Note: metformin is the single exception in Klompas
criterion 2, so distinguish `metformin_only` from `other` carefully. Cite the
drug rows.

## Examples

- Metformin 1000 mg BID, nothing else → `metformin_only`
- Metformin + semaglutide → `other`
- Empagliflozin only → `other`
- No oral/injectable non-insulin agents in a complete med rec → `none`
- Med history unavailable → `no_info`
