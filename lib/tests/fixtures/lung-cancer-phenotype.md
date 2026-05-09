---
task_id: lung_cancer_phenotype
task_type: phenotype_validation
review_unit: patient
manual_version: "2026-04-28"
index_anchor: index_date
time_windows:
  - { id: lookback_24mo, anchor: index_anchor, start_offset: -24mo, end_offset: 0d }
final_output: lung_cancer_status
---

# Lung Cancer Phenotype Review

## Overview

This task determines whether a patient has lung cancer based on their EHR record. The phenotype produces a three-tier label: `confirmed` (pathology-supported), `probable` (imaging plus clinical diagnosis, or coding-only), or `absent` (no supporting evidence in the lookback window).

**Source-document priority** (apply globally unless a field overrides):

1. Surgical pathology report (LOINC 11526-1)
2. Biopsy pathology report
3. Outside-institution pathology in the media tab
4. Treating-oncologist progress notes
5. Imaging reports (CT chest, PET-CT)
6. Problem list / encounter ICD codes

**Lookback window** is 24 months prior to the index date. The index date is the start of the encounter that triggered the review.

## Field `pathology_report_present`

```yaml
prompt: "Is a qualifying pathology report present in the lookback window?"
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: pathology
extraction_guidance: "Search note documents tagged pathology_report, surgical_pathology, or LOINC 11526-1."
```

### Definition
A pathology report authored by a credentialed pathologist. Surgical and biopsy specimens both qualify. Cytology-only diagnoses do not qualify here — record `no` and let `pathology_lung_primary` capture cytology separately if needed.

### Examples
- "Final diagnosis: Adenocarcinoma of the lung, T2N1M0" → `yes`
- "Suspicious for malignancy, recommend re-biopsy" → `no_info`
- No pathology document found in the 24-month window → `no`

## Field `pathology_lung_primary`

```yaml
prompt: "What primary site / histology does the pathology report indicate?"
answer_schema: { enum: [nsclc, sclc, other_lung, non_lung, no_info] }
cardinality: one
time_window: lookback_24mo
group: pathology
is_applicable_when: "pathology_report_present == 'yes'"
extraction_guidance: "Apply WHO mapping below."
```

### Definition / WHO mapping
NSCLC subtypes (adenocarcinoma, squamous cell carcinoma, large-cell carcinoma) collapse to `nsclc`. Carcinoid tumors map to `other_lung`. Mesothelioma maps to `non_lung`. Metastatic disease without lung primary → `non_lung`.

### Conflict resolution
If multiple pathology reports conflict, prefer the most recent unless a documented re-read exists. If a re-read is documented, the re-read wins regardless of date.

### Examples
- "Adenocarcinoma of the lung" → `nsclc`
- "Small cell carcinoma, lung" → `sclc`
- "Carcinoid tumor of the lung" → `other_lung`
- "Metastatic colorectal carcinoma" → `non_lung`

## Field `cytology_supports_lung_primary`

```yaml
prompt: "Does cytology (no surgical/biopsy specimen available) support a lung primary?"
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: pathology
is_applicable_when: "pathology_report_present == 'no'"
extraction_guidance: "Only evaluated when no qualifying pathology report exists. Look for cytology reports (FNA, sputum, pleural fluid) tagged as suspicious or positive for lung primary."
```

### Definition
Fallback when surgical or biopsy pathology is unavailable. A cytology specimen
(fine-needle aspiration, sputum cytology, or pleural fluid cytology) interpreted
by a credentialed pathologist as suspicious for or diagnostic of a lung primary
malignancy. Cytology-only diagnoses do not satisfy `pathology_lung_primary` —
they are recorded here so downstream derivation can still capture them as a
weaker tier of pathology evidence.

## Field `imaging_lung_lesion`

```yaml
prompt: "Does imaging show a lung mass, nodule, or lesion suspicious for malignancy?"
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: imaging
```

### Definition
Imaging (CT chest, PET-CT, chest X-ray) shows a lung mass, nodule, or lesion suspicious for malignancy. Stable benign-appearing nodules do not qualify.

### Examples
- "3.2 cm spiculated mass in the right upper lobe, highly suspicious for malignancy" → `yes`
- "Stable 4 mm nodule, likely granuloma" → `no`
- "No prior imaging available for comparison" → `no_info`

## Field `oncologist_lung_cancer_diagnosis_in_note`

```yaml
prompt: "Does a treating oncologist or pulmonologist document lung cancer as the diagnosis?"
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: clinical_diagnosis
extraction_guidance: "Author role must be oncologist or pulmonologist. Family history mentions do not count."
```

### Definition
A treating oncologist or pulmonologist documents lung cancer as the patient's diagnosis (active or historical). Family history mentions, "rule out" language, and provider-questioned diagnoses do **not** qualify.

### Examples
- Oncology progress note: "Patient with stage IIIA NSCLC, currently on cisplatin/etoposide" → `yes`
- "Father with history of lung cancer" → `no`
- "Considering lung cancer in differential, awaiting biopsy" → `no_info`

## Field `lowest_hemoglobin_in_window`

```yaml
prompt: "Lowest documented hemoglobin in the lookback window (g/dL). Null if no hemoglobin measurement is found."
answer_schema: { type: ["number", "null"] }
cardinality: one
time_window: lookback_24mo
group: labs
extraction_guidance: "Search OMOP measurements (LOINC 718-7 / concept name 'Hemoglobin' or 'Hgb') and note text (Hgb, Hb, hemoglobin) within the lookback window. Report the single lowest value. If multiple units appear, normalize to g/dL (a g/L value divided by 10). If no hemoglobin is found, return null with missingness_reason='not_documented'."
```

### Definition
A lab-value extraction field. Hemoglobin is reported in grams per deciliter (g/dL). Values reported in g/L are divided by 10. Cancer-related anemia of chronic disease commonly produces values below 12 g/dL in untreated lung-cancer patients; this field feeds the derived `pre_treatment_anemia_present` flag.

### Examples
- OMOP measurement row "Hemoglobin 11.4 g/dL on 2025-02-14" → `11.4`
- Discharge summary line "Pre-op Hgb 11.6, transfusion not required" → `11.6`
- No hemoglobin documented anywhere in the window → `null` with `missingness_reason: not_documented`

## Field `pre_treatment_anemia_present`

```yaml
prompt: "Is anemia (Hgb < 12 g/dL) documented in the lookback window?"
answer_schema: { type: ["boolean", "null"] }
derivation: "lowest_hemoglobin_in_window != null AND lowest_hemoglobin_in_window < 12.0"
group: derived
```

### Definition
True iff a hemoglobin measurement under 12 g/dL exists in the lookback window. Used as a context signal for downstream cohort filtering — does not affect `lung_cancer_status`.

## Field `icd_lung_cancer_present`

```yaml
prompt: "Is an ICD-10 C34.* code on the problem list or any encounter diagnosis?"
answer_schema: { enum: [yes, no] }
cardinality: one
time_window: lookback_24mo
group: codes
extraction_guidance: "Query CONDITION_OCCURRENCE for ICD-10-CM C34.* codes. Personal-history codes (Z85.118) do not qualify here."
```

### Definition
An ICD-10-CM code in the C34.* family appears on the patient's problem list or any encounter diagnosis within the lookback window.

### Examples
- C34.10 on a 2025-09-12 encounter → `yes`
- Only Z85.118 ("personal history of malignant neoplasm of bronchus and lung") → `no`
- No relevant codes → `no`

## Field `pathology_confirms_lung_cancer`

```yaml
prompt: "Does pathology confirm lung cancer?"
answer_schema: { type: boolean }
derivation: "pathology_report_present == 'yes' AND pathology_lung_primary in ['nsclc','sclc','other_lung']"
group: derived
```

### Definition
True iff a pathology report exists AND it identifies a lung primary malignancy. Derived field — no evidence required; provenance is the input field values.

## Field `clinical_diagnosis_lung_cancer`

```yaml
prompt: "Imaging plus oncologist clinical diagnosis present?"
answer_schema: { type: boolean }
derivation: "imaging_lung_lesion == 'yes' AND oncologist_lung_cancer_diagnosis_in_note == 'yes'"
group: derived
```

### Definition
True iff imaging shows a suspicious lung lesion AND a treating oncologist or pulmonologist documents lung cancer.

## Field `lung_cancer_status`

```yaml
prompt: "Final phenotype label."
answer_schema: { enum: [confirmed, probable, absent] }
derivation: "pathology_confirms_lung_cancer == true ? 'confirmed' : (clinical_diagnosis_lung_cancer == true OR icd_lung_cancer_present == 'yes') ? 'probable' : 'absent'"
is_final_output: true
group: final
```

### Tier rationale
- `confirmed` requires pathology evidence — the highest-tier evidence available in routine EHR.
- `probable` allows two paths: clinical-diagnosis-with-imaging-support, or an ICD code (the weakest signal but included to match how chart reviewers operate when full pathology is missing).
- `absent` is asserted only when all leaf fields have been evaluated and none support lung cancer.
