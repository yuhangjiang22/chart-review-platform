---
id: incidental_benign
pattern: "Incidental nodule characterized as benign or stable, never pursued"
applies_to:
  - lung_cancer_imaging_suspicious
failure_mode: "Treating every nodule as 'suspicious for malignancy' when radiologist has explicitly characterized it as benign (granuloma, hamartoma, sclerotic lesion)"
correct_answer_hint: "If imaging explicitly diagnoses the nodule as benign (e.g., 'likely granuloma based on imaging appearance,' 'hamartoma'), classify imaging_suspicious as 'No'. If the nodule is stable on serial imaging and radiologist documents 'benign appearance,' classify as 'No'."
---

# Edge Case: incidental_benign

## Pattern

Imaging study identifies a lung nodule but the radiologist explicitly characterizes it as benign based on imaging features (density, shape, calcification pattern) or documents it as stable over multiple years without suspicious growth.

## Why it matters

Not every lung nodule is malignant. A radiologist's explicit benign diagnosis (granuloma, hamartoma, sclerotic lesion) or documentation of stability over years with "benign appearance" should trigger "No" for imaging_suspicious, not "Yes." This prevents over-classification of asymptomatic findings with no follow-up as concerning for cancer.

## How to handle

- If radiologist states "findings consistent with benign etiology" or names a benign diagnosis, classify imaging_suspicious as "No."
- If a nodule is documented as stable across 2+ years of imaging with benign characterization, classify as "No."
- If a nodule is incompletely characterized ("indeterminate; recommend follow-up"), classify as "Yes" (radiologic uncertainty).
- If the nodule was never followed up and status remains truly unknown, classify as "No_info."
