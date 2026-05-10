---
field_id: lung_cancer_pathology_present
prompt: "Is there pathology-confirmed malignancy consistent with lung cancer?"
answer_schema:
  type: enum
  enum: [yes, no, no_info]
cardinality: one
time_window: baseline
group: "Pathology Evidence"
uses:
  code_sets:
    - lung_cancer_icd10
---

# Criterion: lung_cancer_pathology_present

## Definition

"Yes" means the chart contains a pathology report (tissue diagnosis via biopsy, resection, or cytology) explicitly documenting malignant cells consistent with primary lung cancer (adenocarcinoma, squamous cell, small-cell, large-cell, mesothelioma, or other histologic type). "No" means pathology has been performed and explicitly ruled out malignancy or documented only benign findings. "No_info" means no pathology report exists or pathology status is undocumented.

## Extraction guidance

Search pathology reports, surgical pathology sheets, and cytology results. Look for terms like "malignant," "carcinoma," "adenocarcinoma," "squamous cell," "small-cell lung cancer (SCLC)," "non-small-cell lung cancer (NSCLC)," or specific histologic diagnoses. Prioritize tissue over cytology when both are present; if cytology is equivocal, defer to pathology confirmation. Note the specimen source (lung tissue, bronchoscopic brush, fine-needle aspirate). Exclude diagnoses of metastatic lung tumors from other primary sites unless the clinical context makes clear the lung is the primary.

## Examples

**Satisfying**
- "Lung biopsy: adenocarcinoma of the lung" → yes
- "Bronchoscopic brush cytology: malignant cells consistent with squamous cell carcinoma" → yes
- "Pathology report: No malignancy identified in the lung tissue specimen" → no
- No pathology documentation in available records → no_info

**Non-satisfying**
- "Radiology suspicion for malignancy; biopsy pending" → no_info (not yet confirmed)
- "History of lung cancer (from prior records not available)" → no_info (current pathology status unknown)

**Boundary**
- "Pathology: atypical cells, cannot rule out malignancy" → no_info (equivocal; not definitive confirmation)
- "Resection specimen: multiple nodules, one adenocarcinoma, others benign" → yes (at least one malignant nodule confirmed)

## Failure modes

- Conflating imaging suspicion with pathology diagnosis (imaging alone does not satisfy this criterion; pathology tissue must be present)
- Misinterpreting a negative biopsy as "no_info" when biopsy explicitly excluded malignancy (should be "no")
- Including metastatic disease to the lung from non-lung primary (exclude unless lung origin is documented)
