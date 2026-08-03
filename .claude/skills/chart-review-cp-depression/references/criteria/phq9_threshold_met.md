---
field_id: phq9_threshold_met
prompt: Does the highest post-index PHQ-9 score meet or exceed the depression-evidence threshold of 10?
answer_schema:
  enum:
    - "yes"
    - "no"
cardinality: one
group: synthesis
derivation: 'phq9_severity_band == "moderate" || phq9_severity_band == "moderately_severe" || phq9_severity_band == "severe" ? "yes" : "no"'
---

# Criterion: phq9_threshold_met (computed)

## Definition

Whether the highest post-index PHQ-9 total meets the study's depression
evidence threshold of **score ≥ 10**. This is **computed** — not extracted
directly — from `phq9_severity_band`:

| phq9_severity_band | → phq9_threshold_met |
|---|---|
| `moderate` / `moderately_severe` / `severe` | `yes` |
| `minimal` / `mild` / `not_documented` | `no` |

## Extraction guidance

Do not answer this field directly — it is auto-derived from
`phq9_severity_band` and shown on the **Computed** panel. To change it, fix
`phq9_severity_band`; this value recomputes. Confirm the computed value
during validation.
