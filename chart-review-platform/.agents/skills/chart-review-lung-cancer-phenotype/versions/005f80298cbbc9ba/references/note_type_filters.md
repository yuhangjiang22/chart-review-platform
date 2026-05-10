---
description: Per-criterion note-type priority, codified from cohort.
filters:
  pathology_report_present:
    high:
    - unknown
  cytology_supports_lung_primary:
    high:
    - unknown
  imaging_lung_lesion:
    high:
    - unknown
  oncologist_lung_cancer_diagnosis_in_note:
    high:
    - unknown
  icd_lung_cancer_present:
    low:
    - pcp followup
    - unknown
  lowest_hemoglobin_in_window:
    medium:
    - unknown
  pathology_lung_primary:
    medium:
    - unknown
derived_from:
  cohort_size: 5
  cohort_oracle_done_count: 5
  codified_at: '2026-05-07T14:27:45.697417+00:00'
  guideline_manual_version: '2026-04-28'
provenance:
  source: codify-derived
---
# note_type_filters

Codify-derived per-criterion note-type priority.
