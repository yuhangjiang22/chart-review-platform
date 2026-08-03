---
field_id: klompas_ketone_strip
prompt: Klompas criterion — urine ketone/acetone strip prescription?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: klompas
derivation: 'ketone_strip_rx == "yes" ? "met" : "not_met"'
---

# Criterion: klompas_ketone_strip (computed)

## Definition

Whether a **urine ketone/acetone test-strip prescription** is documented.
**Computed** from `ketone_strip_rx` — do not answer directly. A ketone lab result
does not satisfy this (see `ketone_strip_rx`).
