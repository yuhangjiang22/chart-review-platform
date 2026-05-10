---
field_id: sofa_baseline_score
prompt: What is the patient's pre-index baseline SOFA score (closest documented SOFA in the prior 12 months, or 0 if no baseline available)?
answer_schema:
  type: integer
  minimum: 0
  maximum: 24
is_final_output: false
time_window: pre_index_baseline
---

## Definition

Pre-index baseline SOFA. Sepsis-3 specifies that baseline SOFA is the
patient's chronic SOFA score before the acute illness; for patients
without prior data, baseline is assumed to be 0. SOFA range 0–24
(6 components × 0–4 points each).

## Extraction guidance

- Look back up to 12 months for the most recent fully-scored SOFA
  documented in the chart.
- If no fully-scored SOFA is documented but partial component data
  exists (e.g. baseline creatinine, baseline platelets), reconstruct
  what's available; for missing components, score 0 per Sepsis-3
  default.
- For patients with no prior healthcare encounter or no labs in the
  12-month window, baseline = 0.
- Patients on chronic vasopressors would inflate baseline cardiovascular
  SOFA — flag as an edge case (deferred to v1).

## Examples

- Outpatient labs from 6 months prior: Cr 1.0 (renal=0), platelets 220k
  (coag=0), bilirubin 0.8 (liver=0), no documented respiratory or CV
  failure, GCS 15 → SOFA = 0
- Prior ICU admission 4 months ago with documented SOFA 3 (chronic
  renal disease) → SOFA = 3
- No prior records → SOFA = 0 (per Sepsis-3 default)

## Boundary / failure modes

- Multiple prior SOFAs in the window: use the most recent.
- Patient with chronic dialysis → renal SOFA = 4 chronically; this is a
  legitimate baseline elevation, not noise.
- A SOFA documented ONLY in the index admission's first 48h is NOT
  baseline — that's the acute score (next criterion).
