---
field_id: pathology_total
prompt: Final test field.
answer_schema:
  type: enum
  enum: [yes, no]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if patology_present == "yes" then "yes" else "no"
---

## Definition

Test fixture rolling up the leaf, with a typo.
