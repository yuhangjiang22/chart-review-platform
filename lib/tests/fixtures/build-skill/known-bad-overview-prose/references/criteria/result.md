---
field_id: result
prompt: Final answer.
answer_schema:
  type: enum
  enum: [yes, no]
is_final_output: true
derivation:
  kind: expression
  expr: |
    "yes"
derivation_truth_table:
  - inputs: {}
    expected: "yes"
---

## Definition

Trivial constant for the reversion-residue fixture.
