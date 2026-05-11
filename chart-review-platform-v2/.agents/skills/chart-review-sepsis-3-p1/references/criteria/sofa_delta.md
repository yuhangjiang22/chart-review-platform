---
field_id: sofa_delta
prompt: What is the SOFA delta (acute minus baseline) for this patient?
answer_schema:
  type: integer
  minimum: -24
  maximum: 24
is_final_output: false
derivation:
  kind: expression
  expr: |
    sofa_acute_score - sofa_baseline_score
---

## Definition

The Sepsis-3 ΔSOFA is defined as the difference between the acute peak
(48h post-index) and the chronic baseline. A delta of ≥2 indicates
acute organ dysfunction attributable to the suspected infection.

## Extraction guidance

Derived field — the platform evaluates the expression. Reviewers
should not override; corrections go to the leaf scores.

## Examples

- baseline 0, acute 6 → delta 6
- baseline 3, acute 5 → delta 2 (just at threshold)
- baseline 4, acute 3 → delta −1 (improvement, no acute dysfunction)

## Boundary / failure modes

- Negative delta: patient is improving relative to baseline; not sepsis
  by Sepsis-3 criteria even if abs SOFA is high.
