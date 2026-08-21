---
field_id: crit_b_stiffness
prompt: Criterion B - liver stiffness within 1 year - VCTE >=12.5 kPa or MRE >=5.0 kPa?
answer_schema:
  enum: [met, not_met]
cardinality: one
group: step1_criteria
---

# Criterion B: liver stiffness (window <=1 year)

## Definition
Liver stiffness **within 1 year** before index: **VCTE (FibroScan)
>=12.5 kPa** or **MR elastography >=5.0 kPa**. (LCN Table 2, criterion B.)

## Extraction guidance
**Always commit one value.** Use the reported stiffness value; do not infer
from a fibrosis-stage word without a number. Values below threshold -> `not_met`.
Cite the report span containing the kPa value; state the exam date/window.

## Examples
- "FibroScan: median LSM 18.5 kPa" (3mo before index) -> `met`
- "MRE: liver stiffness 5.6 kPa" -> `met`
- "VCTE 9.8 kPa" -> `not_met`
- "FibroScan 14 kPa" 20 months before index -> `not_met` (out of window)
