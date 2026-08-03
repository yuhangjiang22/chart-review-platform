---
field_id: klompas_c_peptide
prompt: Klompas criterion — low/negative C-peptide?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: klompas
derivation: 'c_peptide_result == "low" ? "met" : "not_met"'
---

# Criterion: klompas_c_peptide (computed)

## Definition

Whether a **low C-peptide** (`< 0.8 ng/mL`) is documented. **Computed** from
`c_peptide_result` — do not answer directly. `normal`, `high`, and `not_measured`
are `not_met`.
