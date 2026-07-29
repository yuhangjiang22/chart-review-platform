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
- `ge50_le8d` — anchor showed a ≥50% decrease within 8 days of stop.
- `ge50_le30d` — anchor showed a ≥50% decrease after day 8 but within 30 days.
- `ge50_le180d` — anchor showed a ≥50% decrease after day 30 but within 180 days.
- `lt50_with_data` — post-stop data present but decrease <50%.
- `increase` — anchor persisted or rose after stopping.

## Extraction guidance

Identify the injury peak and use `get_lab_extremum` to assess the minimum
anchor-lab value within each applicable post-cessation window. Do not restrict the
injury peak to laboratory results occurring before drug cessation; the injury peak
may occur after the drug was stopped.

If the drug was stopped before T0, exclude pre-onset laboratory
values, but continue to measure the 8-, 30-, and 180-day scoring windows from the
drug stop date.

Calculate:

`% decrease = (peak − follow-up value) / peak × 100`

Record the earliest scoring tier in which any eligible laboratory result reaches the
≥50% threshold. Do not use the date of the overall nadir if an earlier value already
crossed the threshold.

Use ALT for hepatocellular injury and ALP for
cholestatic/mixed injury. If bilirubin is used because ALP is not interpretable or as
part of a modified platform rule, document this explicitly as an implementation
adaptation.

**Anchor to the suspect drug's STOP date — never the injury peak (T0).** The
dechallenge measures how the anchor lab moved *after the suspect drug was stopped*.
If the suspect drug has no exposure episode in a relevant window — i.e.
`onset_path = not_calculable`, or `get_drug_episodes` is empty / returns no episode
near T0 — then there is **no dechallenge to measure: commit `no_followup`**. Do NOT
score the injury's own post-T0 decline (the natural resolution of whatever caused it)
as a dechallenge: a drug taken/stopped long before onset cannot produce one, and doing
so fabricates a positive course score. A well-timed anchor drop is only a dechallenge
if the drug was actually on board and then stopped.
