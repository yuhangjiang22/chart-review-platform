---
field_id: crit_d_biomarker
prompt: Criterion D - blood biomarker within 6 months - FIB-4 >2.67 or platelet count <150?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: step1_criteria
---

# Criterion D: blood-based biomarker (window <=6 months)

## Definition
Within 6 months before index: **FIB-4 >2.67** or **platelet count <150**
(the source doc reproduces the paper's "<150/mL" [sic]; operationally
<150 x10^9/L). (LCN Table 2, criterion D.)

## Extraction guidance
**Always commit one value.** Platelets: use the structured `measurements` row
(cite table+row_id). FIB-4: use a documented value; otherwise compute
(age x AST) / (platelets x sqrt(ALT)) ONLY when all inputs are within the
window - say `computed` in the rationale and cite the input rows. Either
branch (FIB-4 OR platelets) suffices.

## Examples
- Platelets 112 (2mo before index) -> `met`
- "FIB-4 = 3.4" in a hepatology note (in window) -> `met`
- Platelets 210 and FIB-4 1.9 -> `not_met`
- Platelets 130 but 9 months before index -> `not_met` (out of window)
