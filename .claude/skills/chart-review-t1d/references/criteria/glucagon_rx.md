---
field_id: glucagon_rx
prompt: Is a glucagon prescription/order documented for this patient?
answer_schema:
  enum: [yes, no]
cardinality: one
group: medications
---

# Criterion: glucagon_rx

## Definition

Whether a **glucagon prescription or order** is documented for this patient
(glucagon emergency kit, Baqsimi nasal, Gvoke). A glucagon Rx is one of the
Klompas criterion-1 signals (with >50% T1D codes).

## Extraction guidance

**Always commit one value:**

- **`yes`** — a patient-specific glucagon prescription/order is documented (drug
  order in `drugs`, or a clear note statement of a glucagon kit prescribed).
- **`no`** — no glucagon prescription documented after checking structured drugs
  and notes.

A general educational mention ("counseled on hypoglycemia") without an actual
glucagon order is **not** a prescription → `no`. Cite the drug row or note span.

## Examples

- `drugs` row "glucagon (rDNA) emergency kit, prescribed 2025-02" → `yes`
- "Baqsimi nasal glucagon prescribed" → `yes`
- No glucagon order anywhere → `no`
