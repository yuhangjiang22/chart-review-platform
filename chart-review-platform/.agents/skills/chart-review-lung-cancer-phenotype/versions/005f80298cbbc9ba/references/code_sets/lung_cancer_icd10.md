---
id: lung_cancer_icd10
description: ICD-10-CM codes for active malignant neoplasm of the bronchus and lung.
system: ICD10
includes_pattern:
  - C34.*
version: "2026-04-30"
codes:
  - code: C34.00
    description: Malignant neoplasm of unspecified main bronchus
  - code: C34.01
    description: Malignant neoplasm of right main bronchus
  - code: C34.02
    description: Malignant neoplasm of left main bronchus
  - code: C34.10
    description: Malignant neoplasm of upper lobe, unspecified bronchus or lung
  - code: C34.11
    description: Malignant neoplasm of upper lobe, right bronchus or lung
  - code: C34.12
    description: Malignant neoplasm of upper lobe, left bronchus or lung
  - code: C34.2
    description: Malignant neoplasm of middle lobe, bronchus or lung
  - code: C34.30
    description: Malignant neoplasm of lower lobe, unspecified bronchus or lung
  - code: C34.31
    description: Malignant neoplasm of lower lobe, right bronchus or lung
  - code: C34.32
    description: Malignant neoplasm of lower lobe, left bronchus or lung
  - code: C34.80
    description: Malignant neoplasm of overlapping sites of unspecified bronchus and lung
  - code: C34.81
    description: Malignant neoplasm of overlapping sites of right bronchus and lung
  - code: C34.82
    description: Malignant neoplasm of overlapping sites of left bronchus and lung
  - code: C34.90
    description: Malignant neoplasm of unspecified part of unspecified bronchus or lung
  - code: C34.91
    description: Malignant neoplasm of unspecified part of right bronchus or lung
  - code: C34.92
    description: Malignant neoplasm of unspecified part of left bronchus or lung
excludes:
  - code: Z85.118
    reason: "Personal history of malignant neoplasm of bronchus and lung — historical, not active disease."
provenance:
  source: hand-authored
  approved_by: pi
  approved_at: "2026-04-30"
  status: approved
---

# Code Set: lung_cancer_icd10

Active malignant neoplasm of the bronchus and lung (ICD-10-CM C34 family).
Use this code set when querying CONDITION_OCCURRENCE or encounter diagnoses
for `icd_lung_cancer_present`.

## Included codes

| Code | Description |
|---|---|
| C34.00 | Malignant neoplasm of unspecified main bronchus |
| C34.01 | Malignant neoplasm of right main bronchus |
| C34.02 | Malignant neoplasm of left main bronchus |
| C34.10 | Malignant neoplasm of upper lobe, unspecified bronchus or lung |
| C34.11 | Malignant neoplasm of upper lobe, right bronchus or lung |
| C34.12 | Malignant neoplasm of upper lobe, left bronchus or lung |
| C34.2 | Malignant neoplasm of middle lobe, bronchus or lung |
| C34.30 | Malignant neoplasm of lower lobe, unspecified bronchus or lung |
| C34.31 | Malignant neoplasm of lower lobe, right bronchus or lung |
| C34.32 | Malignant neoplasm of lower lobe, left bronchus or lung |
| C34.80 | Malignant neoplasm of overlapping sites of unspecified bronchus and lung |
| C34.81 | Malignant neoplasm of overlapping sites of right bronchus and lung |
| C34.82 | Malignant neoplasm of overlapping sites of left bronchus and lung |
| C34.90 | Malignant neoplasm of unspecified part of unspecified bronchus or lung |
| C34.91 | Malignant neoplasm of unspecified part of right bronchus or lung |
| C34.92 | Malignant neoplasm of unspecified part of left bronchus or lung |

## Excluded codes

The following codes must NOT be counted as active disease:

| Code | Reason |
|---|---|
| Z85.118 | Personal history of malignant neoplasm of bronchus and lung — historical, not active disease. When only Z85.118 is present, `icd_lung_cancer_present` = `false`. |

## Usage notes

- Match on the full C34.* pattern (any four-digit or five-digit code beginning with C34).
- Check both the problem list and individual encounter diagnoses within the
  lookback window. A code on a historical problem list entry outside the
  lookback window does not qualify.
- See edge case `z85_118_personal_history_excluded` for the most common
  false-positive scenario.
