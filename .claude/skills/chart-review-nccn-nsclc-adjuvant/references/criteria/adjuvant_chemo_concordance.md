---
field_id: adjuvant_chemo_concordance
prompt: What is the patient's concordance with the NCCN adjuvant chemotherapy recommendation?
answer_schema:
  type: enum
  enum: [concordant, discordant, not_applicable]
is_final_output: true
derivation:
  kind: expression
  expr: |
    if eligible_for_adjuvant == "no" then "not_applicable"
    else if platinum_doublet_within_12wk == "yes" then "concordant"
    else "discordant"
derivation_truth_table:
  - label: not eligible → not_applicable (gate branch)
    inputs:
      eligible_for_adjuvant: "no"
      platinum_doublet_within_12wk: "no"
    expected: "not_applicable"
  - label: eligible + platinum doublet within 12wk → concordant
    inputs:
      eligible_for_adjuvant: "yes"
      platinum_doublet_within_12wk: "yes"
    expected: "concordant"
  - label: eligible + no platinum doublet → discordant
    inputs:
      eligible_for_adjuvant: "yes"
      platinum_doublet_within_12wk: "no"
    expected: "discordant"
  - label: eligible + not_applicable platinum leaf → discordant (gate mismatch)
    inputs:
      eligible_for_adjuvant: "yes"
      platinum_doublet_within_12wk: "not_applicable"
    expected: "discordant"
---

## Definition

Concordance label rolled up from the eligibility gate and the platinum-
doublet-timing leaf:

- **not_applicable** — patient was not eligible per `eligible_for_adjuvant`;
  the recommendation does not apply.
- **concordant** — patient was eligible AND received a platinum doublet
  within 12 weeks of surgery.
- **discordant** — patient was eligible BUT did not meet the platinum-
  doublet-timing leaf (no chemo, wrong regimen, or too late).

v0 does NOT distinguish reasons for discordance (refused, contraindicated,
true_gap) — that split is deferred to v1 as a sibling reason criterion
gated on `adjuvant_chemo_concordance == "discordant"`.

## Extraction guidance

Derived field. The platform evaluates `derivation.expr` against the leaves;
do not fill manually. If the platinum-doublet leaf returns "not_applicable"
(via its is_applicable_when gate), the derivation handles it correctly via
the eligibility branch.

## Examples

- eligible=yes, platinum_doublet=yes → concordant
- eligible=yes, platinum_doublet=no → discordant
- eligible=no → not_applicable

## Boundary / failure modes

- The "discordant for valid clinical reason" case (patient declined; ECOG
  too poor; significant comorbidity) is captured here as `discordant`. The
  v1 reason criterion will pivot the discordant cases into actionable vs
  unavoidable buckets for quality-improvement reporting.
