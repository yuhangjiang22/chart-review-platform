---
field_id: item_3_risk_factors
prompt: RUCAM Item 3 — risk factors score
answer_schema:
  enum: [2, 1, 0]
cardinality: one
group: rucam
---

# Criterion: item_3_risk_factors

## Definition

RUCAM Item 3 score for host risk factors: age and alcohol (hepatocellular) or
alcohol/pregnancy (cholestatic/mixed).

## Extraction guidance

Follow `references/scoring/item-3-risk-factors.md`. Use `get_patient_summary`
(`AGE`, `alcohol_use_disorder`, `pregnancy`). Sum: age ≥55 → +1 (else 0); plus
alcohol present → +1 (hepatocellular) or alcohol/pregnancy present → +1
(cholestatic/mixed) (else 0). Score (one of `2`, `1`, `0`).
