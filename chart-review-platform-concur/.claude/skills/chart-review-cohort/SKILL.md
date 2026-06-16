---
name: chart-review-cohort
description: >
  Analyzes a cohort of completed chart reviews under a locked guideline to
  detect drift, surface override patterns, and generate Role-C-style feedback.
  Use when the user says "what's drifting", "any patterns in recent overrides",
  "Role C analysis", "cohort feedback", "is the guideline still working", "agent
  quality over time", "run cohort QA", or asks for a periodic or quality-assurance
  review of how a locked guideline is performing in production. Outputs a feedback
  report with detected drift, clustered override patterns, and pointers to issues
  that warrant a chart-review-improve proposal. Does not propose edits itself —
  surfaces findings only. Composes with chart-review-improve to act on the
  findings.
metadata:
  author: chart-review-platform
  version: "0.2.0"
---

# Cohort Feedback (Role C)

Continuous-quality monitoring for a **locked** guideline in production. This
skill walks all completed reviews under a locked guideline, computes per-criterion
override rates over two sliding time windows, detects drift where the recent rate
exceeds the baseline by more than the threshold, clusters recent overrides by
pattern, and writes a feedback report. It surfaces findings — it does not propose
edits. Editing is `chart-review-improve`'s job.

## When to use

- User says "what's drifting", "any patterns in recent overrides", "Role C
  analysis", "cohort feedback", "is the guideline still working", "agent quality
  over time", or "run cohort QA"
- Periodically on a production locked guideline to check if override rates are
  increasing
- After a corpus shift (new reviewers, new patient cohort, EHR migration) to
  detect whether the shift broke the guideline's performance

Do not use on draft guidelines — drift analysis requires a sufficient production
baseline.

## Inputs

- **guideline_path**: the locked guideline (`guidelines/<id>/`)
- **reviews_root**: typically `reviews/` — contains
  `reviews/<patient>/<guideline-id>/review_state.json`
- **window** (optional): how recent counts as "recent". Default: 30 days or
  last 50 reviews, whichever is smaller
- **drift_threshold** (optional): percentage-point delta in override rate vs
  baseline. Default: 10 pp
- **min_window_fill** (optional): minimum reviews per window for drift
  computation. Default: 25 each side

## Procedure

1. **Read the guideline.** `<guideline_path>/meta.yaml` and
   `<guideline_path>/criteria/*.yaml` for criterion ids and time_window tags.

2. **Enumerate completed reviews.** For each
   `reviews/<patient>/<guideline-id>/review_state.json`:
   - Skip if `review_status` is not in `["reviewer_validated", "locked"]` —
     unfinished reviews must not contaminate override stats.
   - For each `field_assessments[i]`: if `source == "reviewer"` and
     `original_agent_snapshot` exists, this was an override. Capture
     `{patient_id, criterion, agent_answer, reviewer_answer, edit_reason, edit_note, ts}`.

3. **Compute per-criterion override rate.**
   - `total_reviewer_writes` = # reviewer assessments touching this field.
   - `overrides` = subset where `status == "overridden"`.
   - `rate = overrides / total_reviewer_writes`.

4. **Detect drift** — for each criterion, compute two windowed rates:
   - **current**: most recent N reviewer writes (default N = 50).
   - **baseline**: the N reviewer writes preceding current.
   - Need `>= min_window_fill` in each window. If either is too small, skip
     drift for this criterion and note it in the report.
   - `delta_pp = (current_rate - baseline_rate) × 100`.
   - If `|delta_pp| >= drift_threshold` AND no recent `drift_alert` in the
     audit log for this (criterion, window), flag drift.

5. **Cluster recent overrides.** For each criterion with elevated current
   override rate, cluster by:
   - **edit_reason**: `missed_evidence`, `misinterpreted`, `wrong_rule`,
     `criterion_ambiguous`, `other`. A spike in one category suggests a
     specific failure mode.
   - **Evidence pattern**: recurring quote, code, or structural finding in
     reviewer evidence → likely a missing edge case, code, or keyword.
   - **Temporality**: did drift coincide with a corpus shift?

6. **Write feedback report** to `cohorts/<guideline-id>/feedback.json`
   (machine-readable, replaces any prior version) and
   `cohorts/<guideline-id>/feedback.md` (human-readable):

   ```markdown
   # Cohort feedback: <guideline-id>
   Generated: <ts>
   Window: last <N> reviews (vs baseline of <N> prior)

   ## Summary
   - <total_reviews> reviews analyzed.
   - <criteria_with_drift> criteria show drift.
   - <override_clusters_count> override clusters identified.

   ## Drift signals

   ### <criterion_id>
   - Baseline rate: <X>% (<n> / <N> overrides)
   - Current rate:  <Y>% (<n> / <N> overrides)
   - Delta = <+/-Z> pp
   - Cluster (by edit_reason): ...
   - Cluster (by evidence): ...
   - Likely failure mode: ...
   - Recommended next step: run `chart-review-improve` on these <N> patients.

   ## Other observations
   - <criterion>: stable. ...

   ## Patients with multiple overrides
   - <patient_id>: overrode <N> of <M> criteria. Worth a closer look.
   ```

7. **Append a drift_alert audit entry** for each drift finding, so the
   platform's auto-Role-C cooldown sees it. If the platform's
   `drift-detector.ts` already does this, skip — don't double-emit.

8. **Summarize for the user** in 3-5 sentences: how many drift signals, the
   top cluster, and the recommended next action (typically: run
   `chart-review-improve` on the worst criterion).

## Universal references

- See `skills/chart-review/references/lifecycle.md` for the production
  monitoring phase this skill covers.
- See `skills/chart-review/references/reliability-metrics.md` for the override
  rate interpretation context.

## Hard rules (with reasons)

- **Output goes ONLY to `cohorts/<guideline-id>/`.** Cohort feedback reports
  are QA artifacts — writing to guideline or review paths would corrupt the
  data model.
- **Don't include unfinished reviews in stats.** Unfinished reviews have
  incomplete override counts; including them would make override rates appear
  lower than reality and mask drift.
- **Don't propose edits.** This skill surfaces findings; `chart-review-improve`
  makes proposals. Conflating the two roles undermines the methodologist's
  oversight of guideline changes.
- **Drift requires both windows to have ≥ min_window_fill reviews.** A delta
  computed from 3 reviews vs 50 is statistically meaningless and would generate
  false alerts; the fill requirement prevents this.
- **Honor cooldown — don't re-flag the same drift signal more than once per
  cooldown period (default 30 minutes).** Repeated alerts for the same signal
  fatigue the methodologist and obscure new signals.

## Troubleshooting

**Only one window's worth of data (new guideline):** Report "insufficient data
for drift analysis." Emit current override rates without a baseline comparison.
This is the expected state for a new guideline in its first production weeks.

**Override rate is high but stable (no drift):** Baseline 30%, current 32% —
delta below threshold. Don't flag as drift; note in summary that the criterion
is "chronically high override" and may warrant a `chart-review-improve` pass
even though it's not drifting.

**One reviewer dominates the cohort:** If 80% of reviews are by one person,
"override patterns" may reflect that person's preferences rather than protocol
issues. Stratify by reviewer in the cluster analysis and flag: "override patterns
concentrate in <reviewer_id> (X of Y); consider whether this is reviewer style
vs protocol issue."
