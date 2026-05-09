# Lifecycle phases

A guideline (phenotype rubric) moves through these phases once. Forward-only;
backward transitions require methodologist privilege and are recorded in
`maturity.json`'s `transitions[]` array.

```
draft → piloted → calibrated → locked → deployed → (issues) → new draft (iter+1)
```

## What each phase means

| Phase | What it means | Platform state |
|---|---|---|
| `draft` | Methodologist authoring; no formal data yet | `maturity.json: state=draft`. Pilots may exist but none completed. |
| `piloted` | At least one pilot iteration ran; methodologist hasn't signed off | `maturity.json: state=piloted`. Critique data + proposals available. |
| `calibrated` | Methodologist signed off on pilot results | Pre-lock release gate. Sampling.json's lock_test eligibility met. |
| `locked` | Sealed at a specific `guideline_sha` | The version that gets cited and deployed. SHA-pinned. |
| `deployed` | Locked guideline running on production cohorts | One or more `cohorts/<study_id>/` directories exist. |

## Why linear (not branched)

Clinical research publications cite a specific locked SHA. Branched versioning
makes "which version was used" ambiguous and makes the methods section harder
to write. For research studies, linear is correct. (Branching IS valuable for
long-running production assets that bifurcate — e.g., adult vs pediatric
variants — but irrelevant for a first paper.)

## Where the data lives

The phenotype skill at `.claude/skills/chart-review-<phenotype>-phenotype/`
holds the **portable rubric content** (criteria, code sets, edge cases,
exemplars). The platform's `guidelines/<phenotype>/` directory holds the
**runtime lifecycle state**:

```
guidelines/<phenotype>/
├── maturity.json       — state machine + transitions
├── pilots/iter_NNN/    — iteration history
├── sampling.json       — cohort assignment (dev / lock-test / canary)
├── lock_test/          — held-out validation (gates the lock)
└── versions/           — version-tagged snapshots
```

The skill content is portable across platform deployments; the lifecycle
state is intrinsic to *this* clone of *this* platform.

## Three accuracy numbers (one per validation layer)

A publishable methods section reports three κ values, in order:

1. **Calibration κ** — inter-rater agreement during *development* (dev cohort)
2. **Lock-test κ** — held-out validation *within* the development phase
3. **Deployment κ** — real-world generalization (sample of deployment cohort)

The numbers must trend in this order: calibration ≥ lock-test ≥ deployment.
The "gap" between calibration and deployment is the load-bearing finding for
journal reviewers.

See `docs/superpowers/specs/2026-05-03-post-mvp-blueprint.md` §4 for the full
discussion. The chart-review-cohort skill handles deployment-stage validation.
