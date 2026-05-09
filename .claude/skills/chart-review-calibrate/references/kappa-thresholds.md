# Kappa thresholds — chart-review-calibrate

Inter-rater reliability buckets used by the calibration skill, based on
Landis & Koch (1977) and standard clinical research practice.

## Landis & Koch buckets

| Cohen's κ | Label | Platform action |
|---|---|---|
| κ ≥ 0.80 | Excellent | Green-light. Criterion passes. |
| 0.60 ≤ κ < 0.80 | Acceptable | Note for follow-up. Passes but warrants monitoring. |
| 0.40 ≤ κ < 0.60 | Weak | Recommend tightening; flag in report as needing work. |
| κ < 0.40 | Poor | Block locking; criterion must be revised before proceeding. |

## Locking gate

The methodologist typically requires **κ ≥ 0.70** across all primary
criteria before locking. Derived fields are excluded — their values are
mechanically computed from leaf inputs, so inter-rater variance is
meaningless for them.

## κ formula

```
Po = proportion of patients where both reviewers gave the same answer

For each category c:
  pa_c = reviewer A's frequency of c
  pb_c = reviewer B's frequency of c

Pe = Σ (pa_c × pb_c)

κ = (Po − Pe) / (1 − Pe)
```

**Edge case:** if `1 − Pe == 0` (all answers in the sample are identical for
both reviewers), report κ = 1.0 by convention, but flag it: "n unique answers
= 1; criterion may lack variance in this sample."

## Minimum sample requirements

- **n_shared ≥ 10** per criterion for κ to be meaningful. Below this,
  report κ but flag: "n_shared too low to be reliable."
- **n_shared ≥ 2** reviewers per patient; exclude patients with fewer.

## Metric selection by criterion type

For the standard κ above to be appropriate, the criterion's answer_schema
should be nominal or binary. For other schema types, consider:

| Criterion type | Recommended metric |
|---|---|
| Binary (yes/no) | Cohen's κ |
| Nominal enum | Cohen's κ |
| Ordinal enum (ordered categories) | Weighted κ |
| Continuous numeric | ICC (intraclass correlation coefficient) |
| Set (multi-select) | Jaccard similarity |
| Date | Date tolerance (e.g., ±3 days agreement) |

See `skills/chart-review/references/reliability-metrics.md` for full
guidance on metric selection.
