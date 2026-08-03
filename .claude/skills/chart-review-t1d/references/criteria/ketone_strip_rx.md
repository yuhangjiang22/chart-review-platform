---
field_id: ketone_strip_rx
prompt: Is a urine ketone/acetone test-strip prescription documented for this patient?
answer_schema:
  enum: [yes, no]
cardinality: one
group: medications
---

# Criterion: ketone_strip_rx

## Definition

Whether a patient-specific **urine ketone / acetone test-strip prescription or
supply order** is documented (Ketostix, urine ketone strips). One of the Klompas
signals supporting T1D.

## Extraction guidance

**Always commit one value:**

- **`yes`** — a urine ketone/acetone **strip prescription or supply order** is
  documented (supply order in `drugs`, or a note stating strips were prescribed).
- **`no`** — none documented.

**A ketone LAB RESULT is NOT a strip prescription.** A serum/urine ketone
measurement (e.g. a beta-hydroxybutyrate lab) counts as a lab, not a strip Rx —
that alone is `no`. Cite the supply order row or note span.

## Examples

- `drugs`/supply row "urine ketone test strips, dispensed" → `yes`
- "Prescribed Ketostix for home ketone monitoring" → `yes`
- Measured urine ketones 2+ on a UA → `no` (lab result, not a strip Rx)
- No strip order anywhere → `no`
