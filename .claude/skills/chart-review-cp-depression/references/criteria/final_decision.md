---
field_id: final_decision
prompt: What is the final Depression / No Depression decision?
answer_schema:
  enum:
    - depression
    - no_depression
cardinality: one
group: synthesis
derivation: 'study1_tier == "high_confidence" ? "depression" : (study1_tier == "intermediate_confidence" && phq9_threshold_met == "yes") ? "depression" : "no_depression"'
---

# Criterion: final_decision (computed)

## Definition

The final patient-level decision, **computed** from `study1_tier` and
`phq9_threshold_met` per the synthesis table:

| study1_tier | phq9_threshold_met | → final_decision |
|---|---|---|
| `high_confidence` | any | `depression` |
| `intermediate_confidence` | `yes` | `depression` |
| `intermediate_confidence` | `no` | `no_depression` |
| `low_or_no_evidence` | `yes` | `no_depression` (PHQ-only weak signal — see note below) |
| `low_or_no_evidence` | `no` | `no_depression` |

## Extraction guidance

Do not answer this field directly — it is auto-derived from `study1_tier`
and `phq9_threshold_met`, and shown on the **Computed** panel. To change it,
fix a Study 1 leaf or `phq9_severity_band`; this value recomputes.

**`low_or_no_evidence` + `phq9_threshold_met == yes` is a real, expected
combination** — an elevated PHQ-9 with no corroborating narrative evidence
(no diagnosis, no symptoms, no antidepressant, no referral) is treated as a
weak, unconfirmed signal and resolves to `no_depression` per protocol. Do
not treat this as an error to fix — confirm the computed value during
validation and flag it in the patient summary if it occurs, since it may be
worth separate research follow-up.
