---
name: chart-review-calibrate
description: >
  Calibrates a draft chart-review guideline before locking by computing
  per-criterion inter-rater reliability (Cohen's kappa) from blind dual-reviewer
  samples. Use when the user says "calibrate this draft", "is this guideline
  ready to lock", "compute kappa for this protocol", "check inter-rater
  agreement", "validate the rubric", "run a calibration sample", or asks to
  gate locking on agreement metrics. Reports per-criterion kappa with Landis
  and Koch buckets, surfaces disagreements with confusion matrices, and writes
  a calibration report. Acts as the release gate between draft and locked;
  composes with chart-review-improve to act on criteria that fail the kappa
  threshold.
metadata:
  author: chart-review-platform
  version: "0.2.0"
---

# Guideline Calibration

Pre-lock validation for a draft guideline. Two or more reviewers do blind
chart reviews on the same sample of patients; this skill computes per-criterion
Cohen's κ, surfaces low-agreement criteria for tightening, and writes a
calibration report. It is the **release gate** between draft and locked — the
methodologist typically requires κ ≥ 0.70 across all primary criteria before
locking.

## When to use

- User says "calibrate this draft", "is this guideline ready to lock", "compute
  kappa", "check inter-rater agreement", "validate the rubric", or asks to gate
  locking on agreement metrics
- After `chart-review-author` or `chart-review-build` produces a draft and the
  team has collected blind dual-reviewer samples
- After `chart-review-improve` revises low-kappa criteria and a re-calibration
  pass is needed

## Inputs

- **guideline_path**: draft (`.claude/skills/chart-review-<id>/`, with `status: draft` in meta.yaml) or locked (for refresh)
- **patient_ids**: stratified sample of N patients (typical: 10-30)
- **reviewer_ids**: 2+ reviewers who independently completed the same sample
- **Review records**: each reviewer's answers captured separately at
  `reviews/<patient>/<guideline-id>/<reviewer>.json` OR via the platform's
  blinded-review machinery

## Procedure

1. **Verify blind-review preconditions.** For each patient in the sample, check
   that 2+ reviewers' answers exist. Flag and exclude patients with fewer.

2. **Read the guideline.** Enumerate criteria from
   `<guideline_path>/criteria/*.yaml`. Skip derived fields — derivation is
   mechanical and has no inter-rater variance.

3. **Per criterion, compute κ:**
   - Gather `{patient_id, reviewer_a_answer, reviewer_b_answer}` triples.
   - Use the platform's `kappa` MCP tool if available; otherwise compute
     manually using the formula in `references/kappa-thresholds.md`.
   - Build the confusion matrix (categories × categories).

4. **Bucket criteria by κ** using Landis & Koch thresholds — see
   `references/kappa-thresholds.md`. The locking gate is κ ≥ 0.70 on all
   primary criteria.

5. **For each criterion with κ < 0.70**, surface actual disagreements: list
   every `(patient, reviewer-A, reviewer-B)` triple where they disagreed.
   Quote the criterion's `guidance_prose.examples` and note what's ambiguous.
   These observations become direct input to `chart-review-improve`.

6. **Write the calibration report** at
   `calibration/<guideline-id>/<run-id>/report.md`. Contents:
   - Sample metadata (N patients, reviewer IDs, timestamp)
   - Summary (criteria calibrated, how many pass / need work, lock recommendation)
   - Per-criterion κ table with bucket labels
   - For each κ < 0.70 criterion: confusion matrix, list of all disagreements
     with quotes, pattern observations, and recommended next step

7. **Write `calibration/<guideline-id>/<run-id>/raw.json`** with the structured
   data so downstream tools (chart-review-improve, platform QA dashboard) can
   consume it.

8. **Summarize for the user** in 3-5 sentences: per-criterion bucket counts,
   blockers (κ < 0.40 criteria), and recommended next step (lock /
   improve first / re-sample).

## Universal references

- See `skills/chart-review/references/reliability-metrics.md` for guidance on
  which metric to use per criterion type (weighted κ for ordinal, ICC for
  continuous, Jaccard for sets).
- See `skills/chart-review/references/lifecycle.md` for the phase transition
  that this skill gates (draft → calibrated → locked).

## Skill-specific references

- `references/kappa-thresholds.md` — Landis & Koch bucket definitions, the κ
  formula with edge cases, minimum sample requirements, and metric selection
  by criterion type

## Hard rules (with reasons)

- **Output goes ONLY to `calibration/<guideline-id>/<run-id>/`.** Calibration
  reports are audit artifacts; writing to other locations breaks the audit trail.
- **Skip derived fields.** Computing κ on derived fields is meaningless because
  their values are deterministic from leaf inputs — including them would
  artificially inflate the overall agreement numbers.
- **Require ≥ 2 reviewers per patient; exclude patients with fewer.** κ is
  undefined with a single reviewer; including such patients would corrupt the
  computation.
- **Flag κ as unreliable when n_shared < 10.** Small samples produce wildly
  unstable κ estimates; flagging protects the team from making locking decisions
  on noise. See `references/kappa-thresholds.md` for the threshold.
- **Never infer or make up missing answers.** If a reviewer didn't touch a
  criterion for a patient, exclude that pair from that criterion's computation —
  imputing values would misrepresent agreement.

## Troubleshooting

**Only 1 reviewer's data exists:** Can't compute κ with one reviewer. Either
wait for the second reviewer to complete the sample, or run a degraded
"agent vs reviewer" comparison using `chart-review-improve` instead.

**Criterion has only 1 unique answer value in the sample:** κ collapses when
Pe = 1. Report κ but flag it: "n unique answers = 1; reliability not
discriminating. Either the criterion is fine or the sample lacks variance.
Suggest stratified resampling to include cases where the criterion's answer
varies."

**Reviewers disagree on an applicability gate (one marks `not_applicable`,
the other gives an answer):** Flag these as gate-disagreement cases separately
from answer disagreements. The fix is usually to tighten the upstream
criterion's prose, not the gated one. Surface this in the report under the
upstream criterion.
