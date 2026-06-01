---
field_id: adherence_label
prompt: What is the patient's adherence label?
answer_schema:
  type: enum
  enum: [adherent, partial, non_adherent, not_applicable]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if statin_active_at_index == "no" then "not_applicable"
    else if proportion_days_covered_180d >= 0.80 then "adherent"
    else if proportion_days_covered_180d >= 0.50 then "partial"
    else "non_adherent"
derivation_truth_table:
  - label: no active statin → not_applicable (gate branch)
    inputs:
      statin_active_at_index: "no"
      proportion_days_covered_180d: 0.0
    expected: "not_applicable"
  - label: active statin + PDC 0.80 → adherent (at threshold, inclusive)
    inputs:
      statin_active_at_index: "yes"
      proportion_days_covered_180d: 0.80
    expected: "adherent"
  - label: active statin + PDC 0.50 → partial (at lower threshold, inclusive)
    inputs:
      statin_active_at_index: "yes"
      proportion_days_covered_180d: 0.50
    expected: "partial"
  - label: active statin + PDC 0.20 → non_adherent (well below threshold)
    inputs:
      statin_active_at_index: "yes"
      proportion_days_covered_180d: 0.20
    expected: "non_adherent"
---

## Definition

Final adherence label per CMS adherence-measure thresholds:

- **adherent** — PDC ≥ 0.80 (the canonical CMS threshold for "compliant")
- **partial** — PDC 0.50–0.79 (took medication but with gaps)
- **non_adherent** — PDC < 0.50 (significantly under-medicated)
- **not_applicable** — no active statin prescription (the question
  doesn't apply)

## Extraction guidance

Derived. Reviewers should not override; corrections go to the leaves.

## Examples

- statin_active=no → not_applicable
- statin_active=yes, PDC 0.95 → adherent
- statin_active=yes, PDC 0.65 → partial
- statin_active=yes, PDC 0.20 → non_adherent

## Boundary / failure modes

- PDC = 0.80 exactly → adherent (CMS uses ≥, inclusive)
- PDC = 0.50 exactly → partial (cutoff inclusive)
- Patient's prescription was discontinued mid-window for adverse effect
  → still computed as PDC over the time it was active; consider whether
  the population should exclude these patients (deferred to v1).
