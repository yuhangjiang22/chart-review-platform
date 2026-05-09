---
field_id: lung_pathology
prompt: Is pathology positive for lung malignancy?
answer_schema:
  type: enum
  enum:
  - true
  - false
uses:
  keyword_sets:
  - kw_lung_pathology
  code_sets:
  - codes_lung_pathology
---

## Definition

Lung-pathology indicator.
