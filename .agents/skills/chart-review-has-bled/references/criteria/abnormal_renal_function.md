---
field_id: abnormal_renal_function
prompt: Does the patient have abnormal renal function (chronic dialysis, kidney transplant, or serum creatinine ≥ 2.26 mg/dL [200 µmol/L])?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: lookback_lifetime
---

## Definition

The HAS-BLED A component (renal half) scores 1 point if any of:
1. Chronic dialysis
2. Prior kidney transplantation
3. Serum creatinine ≥ 2.26 mg/dL (≥ 200 µmol/L) — most recent value within
   the lookback window

This is a chronic-condition criterion — a remote dialysis episode or
transplant counts; the windowed lookback exists so that we use the most
recent labs and don't penalize a long-resolved AKI from a decade ago.

## Extraction guidance

- Search problem list / ICD-10 N18.x (CKD), Z99.2 (dialysis dependence),
  Z94.0 (kidney transplant)
- Most recent serum creatinine within 10-year lookback (typically the
  most recent outpatient lab is closest to the truth)
- Procedure history for dialysis (90937, 90945, etc.) or transplant

## Examples

**Satisfying ("yes"):**
- "PMH: ESRD on hemodialysis MWF" → yes (dialysis)
- "s/p deceased-donor kidney transplant 2015" → yes
- "Most recent creatinine 2.4 mg/dL" → yes

**Non-satisfying ("no"):**
- "CKD stage 3, creatinine 1.8" → no (below the cutoff)
- "AKI in 2018, creatinine peaked at 2.5 then resolved to 1.0" → no
  (the criterion uses the *current* creatinine value)

## Boundary / failure modes

- Creatinine = 2.26 mg/dL exactly → "yes" (the cutoff is inclusive ≥)
- Patient is on dialysis but has a normal residual creatinine → still
  "yes" (dialysis trumps the lab value)
- A single isolated AKI bump above 2.26 with subsequent recovery → "no"
  (use the most recent value, not the worst)
