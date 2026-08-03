---
field_id: overall_klompas_rule_met
prompt: Is any Klompas T1D criterion met overall?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: klompas
derivation: 'count_true([klompas_1_glucagon == "met", klompas_2_noninsulin == "met", klompas_autoantibody == "met", klompas_c_peptide == "met", klompas_ketone_strip == "met"]) >= 1 ? "met" : "not_met"'
---

# Criterion: overall_klompas_rule_met (computed)

## Definition

The Klompas roll-up: **`met`** when **at least one** of the five Klompas criteria
is met —

1. `klompas_1_glucagon` — >50% T1D codes + glucagon Rx
2. `klompas_2_noninsulin` — >50% T1D codes + no non-insulin med other than metformin
3. `klompas_autoantibody` — positive diabetes autoantibody
4. `klompas_c_peptide` — low C-peptide
5. `klompas_ketone_strip` — urine ketone-strip prescription

**Computed** — do not answer directly. Because every input criterion resolves to
`met`/`not_met` (never blank), this roll-up always computes.
