---
field_id: study1_tier
prompt: What is the Study 1 narrative-evidence confidence tier?
answer_schema:
  enum:
    - high_confidence
    - intermediate_confidence
    - low_or_no_evidence
cardinality: one
group: synthesis
derivation: 'high_confidence_diagnosis == "yes" ? "high_confidence" : (depressive_symptoms == "yes" || antidepressants == "yes" || antidepressants == "indication_not_verified" || psychiatry_referral == "yes") ? "intermediate_confidence" : "low_or_no_evidence"'
---

# Criterion: study1_tier (computed)

## Definition

The overall Study 1 narrative-evidence tier, **computed** from the four
Study 1 leaves — not answered directly:

| high_confidence_diagnosis | any of (depressive_symptoms / antidepressants incl. indication_not_verified / psychiatry_referral) == yes | → study1_tier |
|---|---|---|
| yes | — | `high_confidence` |
| no / no_info | yes | `intermediate_confidence` |
| no / no_info | no (all no/no_info) | `low_or_no_evidence` |

## Extraction guidance

Do not answer this field directly — it is auto-derived from
`high_confidence_diagnosis`, `depressive_symptoms`, `antidepressants`, and
`psychiatry_referral`, and shown on the **Computed** panel. To change it, fix
one of those four leaves; this value recomputes. Confirm the computed value
during validation.

Record the **highest tier reached** across all post-index notes — this is
handled automatically since each leaf field itself already reflects the
strongest evidence found across the whole chart.
