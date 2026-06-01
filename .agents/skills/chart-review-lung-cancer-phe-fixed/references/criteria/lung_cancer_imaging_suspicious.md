---
field_id: lung_cancer_imaging_suspicious
prompt: "Does imaging show findings suspicious for lung malignancy?"
answer_schema:
  type: enum
  enum: [yes, no, no_info]
cardinality: one
time_window: baseline
group: "Imaging Evidence"
uses:
  code_sets:
    - lung_cancer_icd10
---

# Criterion: lung_cancer_imaging_suspicious

## Definition

"Yes" means imaging (CT, X-ray, PET, or MRI) documents a lung nodule, mass, or infiltrate with radiologic features concerning for malignancy (irregular margins, spiculation, high density, FDG uptake, cavitation with thick walls, pleural effusion adjacent to a lesion, or mediastinal adenopathy). "No" means imaging has been performed and explicitly documents no suspicious findings, or findings are benign (e.g., granuloma, hamartoma). "No_info" means no imaging study is documented or imaging results are unavailable.

## Extraction guidance

Extract from radiology reports (chest X-ray, CT chest ± abdomen/pelvis, PET-CT, brain MRI). Note the imaging modality, date, and specific findings. Look for radiologist language like "nodule," "mass," "lesion," "suspicious for malignancy," "cannot exclude malignancy," "ground-glass opacity," "tree-in-bud," or "pleural effusion." Compare to prior studies if available to assess growth or change over time. Exclude incidental findings unrelated to the lungs (e.g., hepatic lesion).

## Examples

**Satisfying**
- "CT chest: 2.5 cm right upper lobe nodule with irregular margins and spiculation, suspicious for malignancy" → yes
- "PET-CT: right upper lobe mass with intense FDG uptake; mediastinal lymphadenopathy" → yes
- "Chest X-ray: no acute findings; no pulmonary nodules or masses identified" → no

**Non-satisfying**
- "Small centrilobular nodules consistent with respiratory bronchiolitis; no acute findings" → no (benign pattern)
- "6 mm apical nodule, likely granuloma; stable on prior studies" → no (benign diagnosis)

**Boundary**
- "CT chest: 8 mm lingular nodule, indeterminate; recommend follow-up imaging in 3 months" → yes (radiologic uncertainty warrants further surveillance; radiologist did not exclude malignancy)
- "Chest X-ray: elevated hemidiaphragm; no focal parenchymal lesion" → no (no lung nodule/mass identified)

## Failure modes

- Marking "yes" for a completely benign nodule that has been explicitly characterized as hamartoma or granuloma
- Confusing pleural effusion alone (without associated nodule/mass) as suspicious for lung cancer
- Including cardiac or mediastinal findings unrelated to pulmonary parenchyma
