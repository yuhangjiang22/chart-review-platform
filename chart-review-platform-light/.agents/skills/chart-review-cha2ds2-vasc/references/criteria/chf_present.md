---
field_id: chf_present
prompt: Does the patient have documented heart failure (HFrEF or HFpEF)?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: lookback_lifetime
---

## Definition

Documented heart failure of any type — reduced (HFrEF, EF ≤40%) or preserved
(HFpEF, EF ≥50%) ejection fraction, or borderline (HFmrEF). Must be a
clinical diagnosis in the problem list, a discharge diagnosis from a heart-
failure admission, or an active heart-failure medication regimen with a
documented HF rationale.

## Extraction guidance

- Problem list / encounter ICD-10: I50.x (any subtype)
- Discharge summaries with primary or secondary HF diagnosis
- Echocardiogram + provider note documenting HF (an isolated low EF on imaging
  without a clinical HF diagnosis does not qualify — many causes other than HF)
- Active medication for HF (ACE-I/ARB/ARNI + beta-blocker + loop diuretic)
  paired with a provider note indicating HF as the indication

## Examples

**Satisfying:**
- "Active problems: heart failure with reduced ejection fraction (EF 30%)"
- "Hospitalized 2023 for acute decompensated HF, NYHA III"
- ICD-10 I50.21 on the problem list

**Non-satisfying:**
- "EF 35% on TTE" with no HF diagnosis or symptoms documented
- "On lisinopril for hypertension" (HF medication used for another indication)
- "Family history of heart failure"

## Boundary / failure modes

- "Heart failure, resolved" → "yes" (CHA₂DS₂-VASc counts history of HF, not
  active HF)
- Pulmonary edema during sepsis → "no" unless a clinician later diagnoses HF
- "Diastolic dysfunction" alone, without an HF diagnosis → "no"
