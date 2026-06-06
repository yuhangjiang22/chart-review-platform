---
field_id: sofa_acute_score
prompt: What is the patient's peak SOFA score in the 48h after ED triage?
answer_schema:
  type: integer
  minimum: 0
  maximum: 24
is_final_output: false
time_window: post_index_48h
---

## Definition

Peak SOFA score in the first 48h after the index event (ED triage).
This is the "acute" pole of the Sepsis-3 SOFA-Δ comparison. Range
0–24.

## Extraction guidance

- Compute SOFA at multiple time points across the 48h window (ED, ICU
  admission, daily ICU rounds), use the maximum across all points.
- Components and their data sources:
  - Respiratory: PaO₂/FiO₂ ratio (ABG + ventilator FiO₂)
  - Coagulation: platelet count
  - Hepatic: total bilirubin
  - Cardiovascular: MAP and vasopressor doses
  - CNS: Glasgow Coma Scale
  - Renal: creatinine and urine output
- For missing components, score 0 (Sepsis-3 default — only available
  data contributes).

## Examples

- Patient in ED with: P/F 250 (resp=2), platelets 90k (coag=2), bili
  1.5 (hep=1), MAP 65 on noradrenaline 0.05 (CV=3), GCS 14 (CNS=1),
  Cr 1.4 (renal=1) → SOFA = 10
- Patient in ED never escalates: P/F 380 (resp=1), platelets 200k
  (coag=0), bili 0.9 (hep=0), MAP 95 (CV=0), GCS 15 (CNS=0), Cr 1.1
  (renal=0) → SOFA = 1

## Boundary / failure modes

- Vasopressor titration: use the peak dose during the 48h, not the
  current dose.
- Mechanical ventilation initiated within the window → respiratory
  component should reflect the post-intubation P/F ratio.
- Discharged from ED before 48h elapsed → use the last available
  values.
