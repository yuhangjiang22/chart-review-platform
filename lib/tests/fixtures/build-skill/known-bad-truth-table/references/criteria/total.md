---
field_id: pathology_total
prompt: Final.
answer_schema:
  type: enum
  enum: [yes, no]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if pathology_present == "yes" then "yes" else "no"
derivation_truth_table:
  - label: positive maps to yes
    inputs: { pathology_present: "yes" }
    expected: "yes"
  - label: BAD ROW expected mismatches the derivation
    inputs: { pathology_present: "no" }
    expected: "yes"
  - label: undeclared input ref - ghost_field
    inputs: { ghost_field: "yes" }
    expected: "yes"
---

## Definition

Test fixture whose truth-table row 2 contradicts the derivation. Row 3
references a field_id (`ghost_field`) not declared in this package; the
validator emits unknown_field_reference for the bad input key and a
follow-up derivation_eval_error because the actual derivation variable
(`pathology_present`) is missing from the row's inputs.
