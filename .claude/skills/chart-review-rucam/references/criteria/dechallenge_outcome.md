---
field_id: dechallenge_outcome
prompt: For Item 2, what was the course after stopping the drug?
answer_schema:
  enum: [not_stopped, no_followup, ge50_le8d, ge50_le30d, ge50_le180d, lt50_with_data, increase]
cardinality: one
group: rucam
role: intermediate
---

# Criterion: dechallenge_outcome

## Definition

The anchor lab's course after the suspect drug was stopped (anchor = ALT for
hepatocellular; ALP/bilirubin for cholestatic/mixed):
- `not_stopped` — drug never stopped in the observation window.
- `no_followup` — stopped, but no post-stop lab data.
- `ge50_le8d` — anchor fell ≥50% with nadir within 8 days of stop.
- `ge50_le30d` — anchor fell ≥50% with nadir within 30 days.
- `ge50_le180d` — anchor fell ≥50% with nadir within 180 days (after 30d).
- `lt50_with_data` — post-stop data present but decrease <50%.
- `increase` — anchor persisted or rose after stopping.

## Extraction guidance

Use `get_lab_extremum` for peak (to drug stop) and nadir (in the window).
% decrease = (peak − nadir)/peak × 100. Record the tier reached. For
cholestatic/mixed, evaluate ALP and bilirubin and record the best (fastest/largest).
