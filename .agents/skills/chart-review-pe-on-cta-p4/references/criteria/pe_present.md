---
field_id: pe_present
prompt: Is acute PE present per CTA findings (final phenotype label)?
answer_schema:
  type: enum
  enum: ["yes", "no", "cannot_determine"]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if cta_chest_performed_at_index == "no" then "no"
    else if pe_workup_indication_documented == "no" then "no"
    else cta_report_documents_pe
derivation_truth_table:
  - label: no CTA performed → no (out of cohort)
    inputs:
      cta_chest_performed_at_index: "no"
      pe_workup_indication_documented: "no"
      cta_report_documents_pe: "no"
    expected: "no"
  - label: CTA performed + no workup indication → no (incidental)
    inputs:
      cta_chest_performed_at_index: "yes"
      pe_workup_indication_documented: "no"
      cta_report_documents_pe: "yes"
    expected: "no"
  - label: CTA performed + indication + report yes → yes
    inputs:
      cta_chest_performed_at_index: "yes"
      pe_workup_indication_documented: "yes"
      cta_report_documents_pe: "yes"
    expected: "yes"
  - label: CTA performed + indication + report cannot_determine → cannot_determine
    inputs:
      cta_chest_performed_at_index: "yes"
      pe_workup_indication_documented: "yes"
      cta_report_documents_pe: "cannot_determine"
    expected: "cannot_determine"
---

## Definition

Final PE-on-CTA phenotype rolled up from eligibility + indication +
the radiology read. Patients without a CTPA, or without documented PE
workup indication, return "no" (they're not in the cohort being
evaluated for PE).

## Extraction guidance

Derived field. Reviewers should not override directly — the most
common correction is on `cta_report_documents_pe` (the
radiologist's read can be ambiguous and a reviewer may decide
differently after reading the full report).

## Examples

- cta_performed=no → no (out of cohort)
- cta_performed=yes, indication=no → no (out of cohort)
- cta_performed=yes, indication=yes, report=yes → yes
- cta_performed=yes, indication=yes, report=cannot_determine →
  cannot_determine
- cta_performed=yes, indication=yes, report=no → no

## Boundary / failure modes

- A patient with positive CTA but the workup-indication leaf is "no"
  (incidental PE on cancer staging) → "no" here. This is a deliberate
  scope limit per the population definition; calibration may surface
  edge-cases for v1.
