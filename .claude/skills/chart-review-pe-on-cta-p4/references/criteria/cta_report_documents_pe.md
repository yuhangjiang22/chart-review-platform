---
field_id: cta_report_documents_pe
prompt: Does the CTA report document acute pulmonary embolism (any segment, including subsegmental)?
answer_schema:
  type: enum
  enum: ["yes", "no", "cannot_determine"]
is_final_output: false
is_applicable_when: 'cta_chest_performed_at_index == "yes" and pe_workup_indication_documented == "yes"'
---

## Definition

Strict reading per build-time decision: any acute PE documented on the
CTA report counts as "yes," including subsegmental PE. Chronic /
remote PE (not acute) does NOT count. Filling defects suggestive of
PE but read as non-diagnostic by the radiologist → cannot_determine.

`cannot_determine` covers:
- Non-diagnostic study (motion, contrast bolus failure, etc.)
- Filling defects of uncertain significance per the radiologist
- Report discrepancy (preliminary vs final disagree)

## Extraction guidance

- Read the FINAL radiology report (not preliminary).
- Search the impression / conclusion for: "pulmonary embolism," "PE,"
  "filling defect" + "embolic," "intraluminal filling defect."
- Subsegmental, segmental, lobar, central — all count as "yes."
- Chronic-PE language ("known chronic thromboembolic disease, no acute
  PE") → "no" for acute PE.
- "Suspicious for PE but image quality limits assessment" →
  cannot_determine.

## Examples

**Satisfying ("yes"):**
- "Acute pulmonary embolism in the right interlobar artery and
  subsegmental branches of the right lower lobe."
- "Filling defects consistent with acute PE, segmental and
  subsegmental."
- "Subsegmental pulmonary embolus, right lower lobe."

**Non-satisfying ("no"):**
- "No evidence of pulmonary embolism."
- "Pulmonary arteries patent to subsegmental level."
- "Chronic thromboembolic disease, no acute PE."

**Cannot determine:**
- "Study limited by motion artifact; PE cannot be excluded."
- "Equivocal subsegmental filling defect, recommend follow-up."

## Boundary / failure modes

- Discrepancy between preliminary read and final read → use the final.
- Addendum altering the impression → use the addendum.
- Patient already on anticoagulation, persistent residual clot
  documented → "no" for acute PE (chronic).
