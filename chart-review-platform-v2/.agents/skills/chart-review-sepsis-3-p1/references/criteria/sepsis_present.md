---
field_id: sepsis_present
prompt: Is sepsis present per Sepsis-3 criteria?
answer_schema:
  type: enum
  enum: [confirmed, probable, absent, cannot_determine]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if infection_suspected_at_index == "yes" and sofa_delta >= 2 then "confirmed"
    else if infection_suspected_at_index == "yes" and sofa_delta == 1 then "probable"
    else "absent"
derivation_truth_table:
  - label: infection yes + sofa_delta 2 → confirmed (at threshold)
    inputs:
      infection_suspected_at_index: "yes"
      sofa_delta: 2
    expected: "confirmed"
  - label: infection yes + sofa_delta 1 → probable (sub-threshold)
    inputs:
      infection_suspected_at_index: "yes"
      sofa_delta: 1
    expected: "probable"
  - label: infection yes + sofa_delta 0 → absent (no acute dysfunction)
    inputs:
      infection_suspected_at_index: "yes"
      sofa_delta: 0
    expected: "absent"
  - label: infection no + sofa_delta 5 → absent (no infection trigger)
    inputs:
      infection_suspected_at_index: "no"
      sofa_delta: 5
    expected: "absent"
---

## Definition

Final Sepsis-3 phenotype label. Confirmed = infection suspicion AND
SOFA-Δ ≥ 2 (canonical Sepsis-3 definition). Probable = infection
suspicion AND SOFA-Δ = 1 (suggestive but sub-threshold per published
criterion). Absent = either no infection suspicion or no acute SOFA
elevation.

`cannot_determine` is reserved for cases the derivation can't resolve
because a leaf returned `cannot_determine` itself — not used by this
v0 derivation since both leaves are binary/integer; the value is
included in the enum for forward compatibility when reviewer overrides
mark a case unclassifiable.

## Extraction guidance

Derived. Reviewers should not override unless a leaf is wrong; correct
the leaf instead.

## Examples

- infection_suspected=yes, sofa_delta=4 → confirmed
- infection_suspected=yes, sofa_delta=1 → probable
- infection_suspected=no, sofa_delta=5 → absent (no infection trigger)
- infection_suspected=yes, sofa_delta=0 → absent

## Boundary / failure modes

- A delta of exactly 1 is "probable" rather than "absent" — the
  Sepsis-3 paper used ≥2 as the threshold, but probable preserves the
  signal for calibration to potentially propose lowering the threshold
  in v1.
