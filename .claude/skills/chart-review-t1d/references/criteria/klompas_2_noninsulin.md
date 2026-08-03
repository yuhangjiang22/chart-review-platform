---
field_id: klompas_2_noninsulin
prompt: Klompas criterion 2 — >50% T1D codes and no non-insulin med other than metformin?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: klompas
derivation: 'gt50_t1d == "yes" AND noninsulin_med in ["none", "metformin_only"] ? "met" : "not_met"'
---

# Criterion: klompas_2_noninsulin (computed)

## Definition

**Klompas criterion 2:** more than 50% of diabetes-type codes are T1D **and** the
patient is on no non-insulin diabetes medication other than metformin. **Computed**
from `gt50_t1d` and `noninsulin_med` — do not answer directly. Note: when
`noninsulin_med` is `no_info` this criterion is `not_met` (the medication history
is not complete enough to satisfy it).
