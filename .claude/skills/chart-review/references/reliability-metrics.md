# Reliability metrics — choose by criterion type

The right inter-rater agreement metric depends on the criterion's
`answer_schema`. This isn't a stylistic choice — using the wrong metric
on the wrong type produces misleading numbers that won't survive peer
review.

## Quick lookup

| Criterion type | Example | Primary metric | Companion metrics |
|---|---|---|---|
| Binary | `pathology_report_present: yes/no` | Cohen's κ | sens / spec / PPV / NPV; confusion matrix |
| Multi-class nominal | `pathology_lung_primary: nsclc / sclc / other` | Cohen's κ | confusion matrix |
| Multi-class ordinal | `lung_cancer_status: absent / probable / confirmed` | **Weighted κ (quadratic)** | confusion matrix |
| Count (integer) | `n_pathology_reports` | **ICC (3,1)** | MAE |
| Continuous | `lowest_hemoglobin_in_window: 9.2 g/dL` | **ICC (3,1)** | MAE; Bland-Altman plot |
| Date | `first_lung_cancer_diagnosis_date` | **% within tolerance window (e.g., ±7 days)** | mean absolute days |
| Set / list | `current_chemotherapy_drugs: [cisplatin, etoposide]` | **Jaccard agreement** | per-element precision/recall/F1 |
| Free text rationale | `rationale: "patient on adjuvant chemo since 2024"` | **Embedding cosine similarity (screening) + human spot-check** | flagged for human review |

## Why each choice

**Cohen's κ for categorical:** chance-corrected, symmetric, field-standard for
chart review. Reports with sensitivity + specificity when prevalence is low
(low-prevalence binary problems can hide bad models behind high κ values).

**Weighted κ for ordinal:** penalizes off-by-one less than far misses.
Quadratic weights are the default in clinical research; linear weights also
acceptable.

**ICC + MAE for continuous:** ICC measures agreement after subtracting
random-chance correlation (κ's continuous analog). MAE is interpretable in
clinical units ("MAE = 0.3 g/dL").

**Bland-Altman plot for continuous:** standard companion figure; reveals
systematic bias (does the agent always read 0.5 g/dL higher than reviewers?).

**Jaccard for sets:** agreement on "what items are in the list," ignoring
order. F1 over set elements is equivalent and more intuitive for some
readers.

**Date metrics:** dates have clinical tolerance (a diagnosis date 7 days off
is usually fine; 7 months isn't). Report both `% exact match` and
`mean absolute days`.

**Free text:** no single metric captures faithfulness + correctness +
completeness. Honest answer: embedding similarity for screening + human
spot-check for the published number.

## Cross-walk: κ vs NLP vs clinical metrics

All three families derive from the same confusion matrix. Different fields
emphasize different cells:

| Underlying ratio | NLP name | Clinical name | κ uses |
|---|---|---|---|
| TP/(TP+FN) | Recall | Sensitivity | feeds p_o |
| TP/(TP+FP) | Precision | PPV | feeds p_o |
| TN/(TN+FP) | (no name) | Specificity | feeds p_o |
| TN/(TN+FN) | (no name) | NPV | feeds p_o |
| (TP+TN)/N | Accuracy | Accuracy | = p_o |
| Harmonic mean of P, R | F1 | (rarely used) | not derivable |
| Marginal × marginal sum | (no analog) | (no analog) | **p_e — unique to κ** |

**Distinctive properties of κ:**
1. Symmetric — neither class is privileged
2. Chance-corrected — subtracts the floor of "agreement by base rate alone"
3. Multi-class natural; F1 in multi-class requires choosing macro/micro/weighted

## Where this is implemented

The platform's `app/server/kappa.ts` currently handles only categorical κ.
A typed reliability dispatch (per `docs/superpowers/specs/2026-05-03-post-mvp-blueprint.md`
§6) is on the post-MVP roadmap — required for any criterion that emits
non-categorical output (e.g., `lowest_hemoglobin_in_window` is numeric).
