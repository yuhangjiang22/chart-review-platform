---
field_id: t1d_classification
prompt: Proposed T1D ground-truth classification (Human-Only final call)
answer_schema:
  enum: [true_likely_t1d, not_t1d, uncertain]
cardinality: one
group: classification
derivation: 'endo_provider_dx == "t1d" ? "true_likely_t1d" : endo_provider_dx == "t2d" ? "not_t1d" : insulin_use == "never" ? "not_t1d" : (c_peptide_result == "low" OR autoantibody_result == "positive") ? "true_likely_t1d" : longterm_noninsulin_before_insulin == "yes" ? "not_t1d" : nonspecialist_dx == "t1d" ? "true_likely_t1d" : nonspecialist_dx == "t2d" ? "not_t1d" : "uncertain"'
---

# Criterion: t1d_classification (computed proposal — Human-Only final call)

## Definition

The **proposed** diabetes-type classification, computed by the guideline's
**sequential ground-truth rule**. This is the machine PROPOSAL only — the final
ground-truth call is **Human-Only**: the reviewer confirms or overrides this value
during VALIDATE.

The sequential rule (first matching step wins):

| # | Condition | → |
|---|---|---|
| 1 | `endo_provider_dx == t1d` | `true_likely_t1d` |
| 1 | `endo_provider_dx == t2d` | `not_t1d` |
| 2 | `insulin_use == never` | `not_t1d` (no history of insulin) |
| 3 | `c_peptide_result == low` OR `autoantibody_result == positive` | `true_likely_t1d` |
| 4 | `longterm_noninsulin_before_insulin == yes` | `not_t1d` |
| 5 | `nonspecialist_dx == t1d` / `t2d` | `true_likely_t1d` / `not_t1d` |
| — | none of the above | `uncertain` |

## Notes

- **Computed — do not answer directly.** To change the proposal, fix the leaf it
  depends on (`endo_provider_dx`, `insulin_use`, `c_peptide_result`,
  `autoantibody_result`, `longterm_noninsulin_before_insulin`, `nonspecialist_dx`).
- Because all six inputs are always-committed enums, this proposal always resolves
  (it never sits at Pending) — but it is explicitly **not** the final answer.
- The DiCAYA proportion (`t1d_code_proportion`) and the Klompas roll-up
  (`overall_klompas_rule_met`) are **supporting** signals shown alongside this
  proposal; the human weighs them when adjudicating.
- Preserve any conflicting evidence in the contributing leaves' rationales so the
  reviewer sees both sides.
