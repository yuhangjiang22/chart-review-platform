---
guideline_id: lung-cancer-phenotype
task_type: phenotype_validation
review_unit: patient
manual_version: "2026-04-28"
index_anchor: index_date
final_output: lung_cancer_status
---

# Case Definition: Lung Cancer Phenotype

## What this task determines

This review task determines whether a patient has lung cancer based on the
available EHR record within a defined lookback window. The phenotype produces
a **three-tier label** assigned to the field `lung_cancer_status`:

| Label | Meaning |
|---|---|
| `confirmed` | Pathology-supported lung cancer diagnosis within the lookback window. A credentialed pathologist has identified a lung primary malignancy from a surgical specimen or biopsy. |
| `probable` | Lung cancer is strongly supported by clinical evidence — either imaging plus an oncologist or pulmonologist's documented diagnosis, or an active ICD-10 C34.* code on the encounter or problem list — but pathology confirmation is absent from the record. |
| `absent` | No supporting evidence for active lung cancer is found within the lookback window. This includes patients who carry only a personal-history code (e.g., Z85.118) but have no active disease indicators. |

## Review window

The lookback window is **24 months** prior to the index date. The index date
is the start of the encounter that triggered the review (defined by
`index_anchor: index_date` in the task manifest).

Window definition:
- Start: 24 months before index date
- End: index date (inclusive)

All criteria that reference a time window use `lookback_24mo` unless
individually overridden.

## Inclusion criteria

A patient is included in the review cohort when:
- An encounter or chart-review trigger has been identified by the study team
- The patient has sufficient EHR data available within the lookback window
  to evaluate at least one leaf criterion

## Exclusion criteria

The following should be noted during review and do **not** count as active
lung cancer evidence:

- **Personal-history codes only (Z85.118):** "Personal history of malignant
  neoplasm of bronchus and lung" is a retrospective code. It does not indicate
  active disease. When Z85.118 is the only lung-cancer-related code, the
  correct answer for `icd_lung_cancer_present` is `false`.
- **Family history mentions:** Notes documenting a family member's lung cancer
  do not qualify for any criterion.
- **Rule-out language:** Phrases such as "considering lung cancer in
  differential, awaiting biopsy" are ambiguous and should be coded as
  `no_info` rather than positive.
- **Metastatic disease without lung primary:** A metastatic deposit in the
  lung from a non-lung primary does not satisfy `pathology_lung_primary`
  (map to `non_lung`) and does not count toward `lung_cancer_status`.

## Source-document priority

Apply this hierarchy globally unless an individual criterion overrides it.
When conflicting information exists across document types, prefer the
higher-priority source:

1. **Surgical pathology report** (LOINC 11526-1) — highest evidentiary weight
2. **Biopsy pathology report** — equivalent to surgical specimen for this rubric
3. **Outside-institution pathology** available in the media tab
4. **Treating-oncologist or pulmonologist progress notes**
5. **Imaging reports** (CT chest, PET-CT, chest X-ray)
6. **Problem list or encounter ICD codes** — weakest signal; sufficient for
   `probable` only, never for `confirmed`

## Label derivation logic

The final `lung_cancer_status` label is computed from leaf criteria:

```
lung_cancer_status =
  pathology_confirms_lung_cancer == true
    ? "confirmed"
    : (clinical_diagnosis_lung_cancer == true OR icd_lung_cancer_present == true)
      ? "probable"
      : "absent"
```

Where:
- `pathology_confirms_lung_cancer` = `pathology_report_present AND pathology_lung_primary IN [nsclc, sclc, other_lung]`
- `clinical_diagnosis_lung_cancer` = `imaging_lung_lesion AND oncologist_lung_cancer_diagnosis_in_note`

The anemia field (`pre_treatment_anemia_present`, derived from `lowest_hemoglobin_in_window`)
is a context signal for downstream cohort filtering. It does **not** affect `lung_cancer_status`.

## Source metadata

This case definition is derived from `guidelines/lung-cancer-phenotype/meta.yaml`
(manual_version: 2026-04-28,
source_document_sha: sha256:9ed4d2d4218d6771fe8cbf9cb9a58b722643ab4eedb1dc9e21410ff066831dcc).
