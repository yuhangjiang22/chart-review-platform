---
field_id: pe_workup_indication_documented
prompt: Is there documented PE workup indication for the CTA — Wells score, D-dimer, or "suspected PE" in the order?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: pre_cta_24h
is_applicable_when: 'cta_chest_performed_at_index == "yes"'
---

## Definition

Documented clinical suspicion of PE preceding the CTA, evidenced by at
least one of:
1. Wells score (or revised Geneva score) documented in the chart
   within 24h of the CTA.
2. D-dimer ordered within 24h preceding the CTA.
3. Order indication explicitly mentions "PE," "pulmonary embolism,"
   "VTE," or "rule out PE."

Used to restrict the population to PE-workup CTAs (excludes incidental
PE findings on cancer-staging or other-indication CTs).

## Extraction guidance

- Order metadata: indication field of the CTA order.
- D-dimer lab result within 24h pre-CTA.
- Provider note in the 24h preceding the CTA (ED note, hospital admit
  note) mentioning PE suspicion or scoring.
- Wells score documented as a specific score (0-12) in the chart.

## Examples

**Satisfying ("yes"):**
- CTA order indication: "Suspected PE; tachycardic, dyspnea"
- D-dimer 850 ng/mL ordered 4h before CTA
- Provider note: "Wells score 6.5, high pre-test probability for PE"

**Non-satisfying ("no"):**
- CTA order indication: "Lung mass, characterize"
- CTA ordered for cancer staging; no PE workup documented
- Patient incidentally found with PE on imaging done for trauma; no
  pre-CTA PE workup documented

## Boundary / failure modes

- D-dimer ordered AFTER the CTA → "no" (the workup must precede the
  imaging).
- ED chief complaint of "chest pain" without explicit PE consideration
  → "no" unless PE is named in subsequent workup.
- Patient on outpatient anticoagulation already, CTA ordered for
  surveillance → strict reading is "no" (no acute PE workup).
