---
field_id: result
prompt: Final answer.
answer_schema:
  type: enum
  enum: [yes, no]
is_final_output: true
time_window_check: skip
derivation:
  kind: expression
  expr: |
    if age_at_index >= 65 then "yes" else "no"
---

## Definition

The phrase "history of" appears here but time_window_check: skip suppresses the heuristic.
This rule decides eligibility currently, at index — without ambiguity.
