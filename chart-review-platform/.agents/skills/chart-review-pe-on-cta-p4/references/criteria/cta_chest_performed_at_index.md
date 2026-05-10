---
field_id: cta_chest_performed_at_index
prompt: Was a CT pulmonary angiography (CTPA) performed at the index encounter?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
---

## Definition

A documented CT pulmonary angiography (CTPA) — chest CT with IV
contrast and PE protocol — performed at the index encounter. Non-PE
chest CT (e.g., low-dose lung-cancer screening, no-contrast chest CT
for fibrosis) does NOT qualify.

Point-in-time evaluation at index — no time_window.

## Extraction guidance

- Procedure codes: CPT 71275 (CT angiography, chest) — the canonical
  CTPA code.
- Imaging report header indicating "PE protocol," "pulmonary
  angiography," "CTPA."
- IV-contrast administration documented.
- Order indication mentioning "PE," "pulmonary embolism," or "VTE
  workup."

## Examples

**Satisfying ("yes"):**
- "CT angiography of the chest, IV contrast, PE protocol"
- "CTPA: pulmonary arteries opacified to subsegmental level"

**Non-satisfying ("no"):**
- "Low-dose chest CT, lung cancer screening"
- "Chest CT without contrast for ILD evaluation"
- "MR angiography of pulmonary arteries" — different modality

## Boundary / failure modes

- A chest CT with IV contrast that wasn't formally PE-protocolled but
  did opacify pulmonary arteries — borderline; strict reading is "no"
  if the report doesn't include pulmonary-artery evaluation. v1 may
  add a permissive option.
- CTPA technically performed but the patient moved excessively, study
  non-diagnostic — the procedure happened, so this is "yes" here; the
  diagnostic question moves to `cta_report_documents_pe`.
