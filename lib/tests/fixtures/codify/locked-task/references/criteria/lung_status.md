---
field_id: lung_status
prompt: Final lung status.
answer_schema:
  type: enum
  enum: [confirmed, probable, absent]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if lung_pathology == "yes" then "confirmed"
    else if lung_imaging == "yes" then "probable"
    else "absent"
uses:
  keyword_sets:
    - kw_hand_authored_anchor
---

## Definition

Final output.
