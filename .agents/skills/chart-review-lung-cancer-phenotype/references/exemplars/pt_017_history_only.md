---
id: pt_017_history_only
title: 'Personal-history code only — answer is absent, not confirmed/probable'
covers_criteria: [icd_lung_cancer_present, lung_cancer_status]
final_label: absent
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: '2026-04-30'
  status: approved
---

## Chart context

A 71-year-old patient with a Z85.118 ("personal history of malignant neoplasm of
bronchus and lung") code on the problem list. No active C34.* code anywhere in
the lookback window. No imaging finding describing a current lung lesion. No
pathology report. The patient was treated for lung cancer many years ago and
is now in surveillance.

## Walkthrough

1. **icd_lung_cancer_present = false**
   - Z85.118 is a *history* code; it does not indicate active disease.
   - No C34.* code is present.
   - Reference: `operational/code_sets/lung_cancer_icd10.yaml` excludes Z85.118 explicitly.

2. **imaging_lung_lesion = no_info** (or `false` if explicit)
   - No CT chest report describing a current lesion.

3. **pathology_report_present = no_info**
   - No pathology report in the lookback window.

4. **clinical_diagnosis_lung_cancer = false** (in this lookback window)
   - Surveillance encounters mention "history of lung cancer" only.

5. **lung_cancer_status = absent**
   - No active code, no imaging finding, no pathology — the rubric resolves to `absent`.

## What to watch for

This is the most common false-positive trap: a history code on the problem list
with no active disease. The reviewer (or agent) should explicitly check whether
any C34.* code is *currently active*, not just whether any lung-cancer-related
code has ever appeared.
