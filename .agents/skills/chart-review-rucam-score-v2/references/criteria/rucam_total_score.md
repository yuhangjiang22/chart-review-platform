---
field_id: rucam_total_score
prompt: What is the patient's RUCAM total score (v0 subset, hepatocellular pattern)?
answer_schema:
  type: integer
  minimum: -10
  maximum: 9
is_final_output: false
derivation:
  kind: expression
  expr: |
    time_to_onset_score + course_score + alt_causes_score + prior_hepatotoxicity_score
time_window_check: skip  # derived rollup — window semantics owned by leaf criteria
---

## Definition

Sum of the four scored RUCAM components included in the v0 subset:
time-to-onset (component 1), course (component 2), alternative-causes (5),
and prior hepatotoxicity (6). Range −10 to +9.

This v0 omits components 3 (risk factors), 4 (concomitant drugs), and 7
(rechallenge). The full RUCAM range is −9 to +14 per Danan & Teschke 2016;
the v0 cap is +9 (2+3+2+2) and floor is −10 (−3+−2+−3+−2).

## Extraction guidance

Derived field — do not fill manually. The platform evaluates the
`derivation.expr` against the leaf scores.

## Examples

- All maxed: 2+3+2+2 = 9 → highly_probable
- Plausible case: 1+2+0+1 = 4 → possible
- Inconsistent timing + worsening course: −3 + −2 + 0 + 0 = −5 → excluded

## Boundary / failure modes

- A single leaf returning out-of-range integer breaks the derivation; the
  contract evaluator surfaces this.
- v0 thresholds for the causality category use the canonical RUCAM cutoffs
  even though our subset has a narrower range — this means fewer cases will
  reach "highly probable" in v0 than in full RUCAM.
