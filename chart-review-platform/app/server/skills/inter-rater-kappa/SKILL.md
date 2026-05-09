---
name: inter-rater-kappa
description: Compute Cohen's kappa per criterion across two or more reviewers from the audit log of locked records. Use to measure agreement on chart-review-guideline application.
---

# Inter-rater Kappa

Computes per-criterion kappa from per-reviewer answers reconstructed from audit JSONLs.

## How it works (today)

Implemented as `app/server/kappa.ts`. Used by the methodologist's QA panel.

## Future externalization

Out of scope for batch E.0.
