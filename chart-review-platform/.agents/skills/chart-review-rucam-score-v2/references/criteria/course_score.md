---
field_id: course_score
prompt: What RUCAM "course of ALT after stopping" score does the patient's ALT trajectory earn?
answer_schema:
  type: integer
  minimum: -2
  maximum: 3
is_final_output: false
time_window: peri_drug
---

## Definition

RUCAM's component 2 (hepatocellular table) scores ALT trajectory after the
drug is stopped:

| Course | Score |
|---|---|
| ALT decrease ≥50% above ULN within 8 days of stopping | +3 |
| ALT decrease ≥50% above ULN within 30 days of stopping | +2 |
| Drug not stopped or course inconclusive | 0 |
| Course not consistent with drug-induced injury (e.g. no improvement; worsening) | −2 |

"Decrease ≥50% above ULN" means: if ALT peaked at X and ULN is U, then by
day 8 (or 30) ALT must be ≤ U + 0.5 × (X − U).

## Extraction guidance

- Use the peak ALT after drug stop (not pre-stop peak) as the baseline for
  the percent-decrease calculation.
- Days are counted from drug-stop date.
- "Drug not stopped" includes: drug continued; drug switched without a
  washout; or unclear from chart.

## Examples

- ALT peak 800 (ULN 40), drug stopped day 0; ALT 400 by day 7 → fall above ULN
  is (800−40) − (400−40) = 760 − 360 = 400, which is 53% of the original 760
  excursion → +3
- ALT peak 800 (ULN 40), ALT 200 by day 25 → fall above ULN is 760 − 160 = 600,
  79% of original → +2
- Drug continued; ALT plateau at 600 → 0
- Drug stopped; ALT continued rising at day 30 → −2

## Boundary / failure modes

- If the patient had a liver transplant or died, course assessment is
  truncated; score the trajectory as documented up to the event and flag.
- If ALT measurements are too sparse (only one post-stop value), document
  uncertainty and pick the closest matching row; do not score 0 unless the
  data genuinely doesn't support a call.
