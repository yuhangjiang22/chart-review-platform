---
field_id: klompas_1_glucagon
prompt: Klompas criterion 1 — >50% T1D codes and a glucagon prescription?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: klompas
derivation: 'gt50_t1d == "yes" AND glucagon_rx == "yes" ? "met" : "not_met"'
---

# Criterion: klompas_1_glucagon (computed)

## Definition

**Klompas criterion 1:** more than 50% of diabetes-type codes are T1D **and** a
glucagon prescription is documented. **Computed** from `gt50_t1d` and
`glucagon_rx` — do not answer directly.
