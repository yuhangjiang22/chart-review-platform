---
field_id: stroke_risk_tier
prompt: What stroke-risk tier does the CHA₂DS₂-VASc total score place this patient in?
answer_schema:
  type: enum
  enum: [low, moderate, high]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if cha2ds2_vasc_score == 0 then "low"
    else if cha2ds2_vasc_score == 1 then "moderate"
    else "high"
derivation_truth_table:
  - label: score 0 → low
    inputs:
      cha2ds2_vasc_score: 0
    expected: "low"
  - label: score 1 → moderate (at threshold)
    inputs:
      cha2ds2_vasc_score: 1
    expected: "moderate"
  - label: score 2 → high (just above moderate threshold)
    inputs:
      cha2ds2_vasc_score: 2
    expected: "high"
  - label: score 9 → high (max possible)
    inputs:
      cha2ds2_vasc_score: 9
    expected: "high"
---

## Definition

Stroke-risk tier per the AHA/ACC anticoagulation thresholds derived from the
CHA₂DS₂-VASc total:

- **low** — total = 0 (annual stroke risk ≤0.5%; no anticoagulation typically
  recommended)
- **moderate** — total = 1 (annual risk ~1–1.5%; anticoagulation reasonable;
  shared decision-making)
- **high** — total ≥ 2 (annual risk ≥2.2%; anticoagulation recommended unless
  contraindicated)

Note that the AHA 2023 update treats female sex (1 point) as a risk modifier
rather than a primary risk factor — i.e. a female patient with a total of 1
attributable solely to sex is sometimes treated as "low" rather than
"moderate." This rubric uses the original Lip 2010 thresholds for simplicity;
calibration may surface this as a guideline-gap signal worth proposing as a
revision.

## Extraction guidance

This is a derived field. The platform evaluates the `derivation.expr` against
`cha2ds2_vasc_score`. Reviewers should not override unless they identify a
score-computation error — in which case the override should be on the leaf
that was wrong, not on this rollup.

## Examples

- score 0 → low
- score 1 → moderate
- score 4 → high
- score 9 → high

## Boundary / failure modes

- The "1 point from sex alone" edge case (see Definition note) is intentionally
  not handled here in the v0; revisit in calibration.
