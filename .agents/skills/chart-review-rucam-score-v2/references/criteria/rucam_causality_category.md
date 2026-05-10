---
field_id: rucam_causality_category
prompt: What RUCAM causality category does the total score place this case in?
answer_schema:
  type: enum
  enum: [excluded, unlikely, possible, probable, highly_probable]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if rucam_total_score <= 0 then "excluded"
    else if rucam_total_score <= 2 then "unlikely"
    else if rucam_total_score <= 5 then "possible"
    else if rucam_total_score <= 8 then "probable"
    else "highly_probable"
derivation_truth_table:
  - label: score 0 → excluded (at boundary)
    inputs:
      rucam_total_score: 0
    expected: "excluded"
  - label: score 1 → unlikely (just above excluded boundary)
    inputs:
      rucam_total_score: 1
    expected: "unlikely"
  - label: score 3 → possible (just above unlikely boundary)
    inputs:
      rucam_total_score: 3
    expected: "possible"
  - label: score 6 → probable (just above possible boundary)
    inputs:
      rucam_total_score: 6
    expected: "probable"
  - label: score 9 → highly_probable (max v0 subset)
    inputs:
      rucam_total_score: 9
    expected: "highly_probable"
---

## Definition

Causality category per the canonical RUCAM cutoffs (Danan & Teschke 2016):

| Total score | Category |
|---|---|
| ≤ 0 | excluded |
| 1–2 | unlikely |
| 3–5 | possible |
| 6–8 | probable |
| ≥ 9 | highly_probable |

These cutoffs apply regardless of which subset of components were scored,
so a v0 case capping at +9 can in principle reach "highly probable" only
when every leaf scores at its maximum.

## Extraction guidance

Derived field. Reviewers should not override unless a leaf was scored
incorrectly — corrections go on the leaf, not on this rollup.

## Examples

- score 6 → probable
- score 0 → excluded
- score −5 → excluded
- score 9 → highly_probable

## Boundary / failure modes

- v0 reaching `highly_probable` requires all four scored leaves to be at max;
  the existing literature reports this is rare without component 7
  (rechallenge), so a v0 result of "probable" is the practical ceiling for
  most cases.
