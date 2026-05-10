---
field_id: pathology_confirms_lung_cancer
schema_hash: 03c77ce7dcc3fc06
prompt: Does pathology confirm lung cancer?
answer_schema:
  type: boolean
group: derived
derivation: pathology_report_present == 'yes' AND pathology_lung_primary in ['nsclc','sclc','other_lung']
---

# Criterion: pathology_confirms_lung_cancer

## Definition

True iff a pathology report exists AND it identifies a lung primary malignancy. Derived field — no evidence required; provenance is the input field values.

