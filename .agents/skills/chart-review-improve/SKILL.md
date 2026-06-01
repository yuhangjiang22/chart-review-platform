---
name: chart-review-improve
description: >
  Improves an existing chart-review guideline by sampling patient charts,
  comparing agent reviews against human ground truth, clustering disagreements,
  and proposing concrete edits. Use when the user says "improve this guideline",
  "the agent keeps getting [criterion] wrong", "we keep overriding [field]",
  "tune the protocol", "fix the [criterion] guidance", "calibrate based on
  disagreements", or after running calibration or cohort-feedback and wanting to
  act on the findings. Writes proposals to proposals/<guideline-id>/<proposal-id>.yaml;
  never modifies the locked guideline directly. Composes with chart-review-calibrate
  (which surfaces κ failures that become this skill's input) and chart-review-cohort
  (which surfaces drift signals).
metadata:
  author: chart-review-platform
  version: "0.2.0"
---

# Guideline Improvement

Takes a guideline (locked or draft) plus a body of patient reviews where
reviewers have provided ground truth, and turns the disagreements into
**concrete proposed edits** to the guideline. It reads override records,
clusters them by pattern, and writes one proposal file per cluster. The
methodologist reviews proposals and decides which to apply; this skill never
edits the guideline directly.

## When to use

- User says "improve this guideline", "the agent keeps getting [criterion] wrong",
  "we keep overriding [field]", "tune the protocol", or "fix the [criterion]
  guidance"
- After `chart-review-calibrate` produces a report with criteria below the κ
  threshold — use this skill to act on the calibration findings
- After `chart-review-cohort` surfaces a drift signal — use this to produce
  proposals for the drifting criterion
- Periodically after accumulating enough production overrides to form clusters

## Inputs

The user or platform provides:

- **guideline_path**: e.g. `guidelines/lung-cancer-phenotype/` (locked) or
  `.claude/skills/chart-review-<id>/` (draft — identified by `status: draft` in meta.yaml)
- **patient_ids**: list of patient ids to analyze, OR a path to a sample.
  If neither is given, ask: "How many patients should I sample, and any
  particular criterion you've been overriding?"
- **review records** at `reviews/<patient>/<guideline-id>/review_state.json`
  — these contain both the agent's original answers AND the reviewer's overrides
  with reasons
- **Optional**: focus criterion. If the reviewer says "the agent keeps getting
  `pathology_lung_primary` wrong", focus on that one criterion.

## Procedure

1. **Read the guideline.** `<guideline_path>/meta.yaml` and
   `<guideline_path>/criteria/*.yaml`. Note which criteria have which `uses:`
   bindings — those are the operational artifacts that exist today.

2. **Read the review records.** For each patient_id, open
   `reviews/<patient>/<guideline-id>/review_state.json`. For each
   `field_assessments[i]`:
   - If `source == "reviewer"` and `original_agent_snapshot` is present,
     this is an **override** — capture both answers, the reviewer's
     `edit_reason` and `edit_note`, and the evidence the reviewer chose.
   - If `source == "reviewer"` with no snapshot, the reviewer answered
     without an agent draft — skip for disagreement analysis.
   - If `source == "agent"`, the reviewer accepted the agent's answer
     (agreement).

3. **Build a disagreement table** (in your head or emit it explicitly):
   `patient_id | criterion | agent_answer | reviewer_answer | edit_reason | evidence_diff`

4. **Cluster disagreements** using the heuristics in
   `references/clustering-heuristics.md`. Look for: same criterion overridden
   3+ times, recurring terms in reviewer evidence, recurring codes, recurring
   clinical scenarios. Each cluster maps to a `change_kind`; see the heuristics
   for the mapping table.

5. **For each cluster, draft one proposal.** Full schema and per-`change_kind`
   shapes in `references/proposal-schema.md`. Write to
   `proposals/<guideline-id>/<proposal-id>.yaml`.

6. **Sanity-check each proposal** before writing: mentally re-run the agent on
   each motivating patient with the proposed change. If 1+ would still fail,
   revise the proposal. If the proposal contradicts `meta.overview_prose`
   intent, surface the conflict in the summary instead.

7. **Write the proposals**, then summarize for the user:
   - Number of disagreements analyzed
   - Number of proposals written, their target_field and change_kind
   - Any disagreements that couldn't be clustered (flag as one-offs needing more
     samples)
   - Suggested next step: methodologist reviews `proposals/<guideline-id>/` and
     accepts/rejects via the platform's proposal queue

## Derived-adjudication signal (annotation-first pilot UI)

When a pilot iter has been run under the annotation-first reviewer flow,
`pilots/<iter_id>/derived-adjudications.json` contains one record per
`(patient_id, field_id)` produced by the LLM classifier on patient lock.
These records complement the `review_state.json` overrides above and
should be folded into the same disagreement table.

For each derived-adjudication record, extract:

- `gap_signal.candidate=true` patients → guideline-gap candidates. Use
  `gap_signal.suggested_revision` as starting material for a
  `guidance_prose_revise` proposal. Cluster across patients before
  committing — single-patient gap signals are usually noise.
- `agent_X.classification = "missed_human_evidence"` patterns → the
  agent did not open the deciding note(s). Cluster on note kinds /
  source types and consider a `keyword_set_add` or scoping change.
- `pair.classification = "both_wrong_same_way"` → systematic guideline
  ambiguity that misled both agents identically. Strong gap signal
  even with small N.
- `reviewer_comment` text → freeform clustering input. Run light
  text similarity across comments under the same field_id; recurring
  themes are clusters even if structured classifications don't match.
- Records with `agent_X.classification = "validation_failed"` are
  classifier failures, not signal — skip them and recommend
  re-running the classifier on those patient/field pairs.

Records under the legacy `pilots/<iter_id>/adjudications.json`
(reviewer-entered 4-class taxonomy from the older UI) remain valid
input but are no longer produced by new pilots. Read both stores when
present.

## Universal references

- See `skills/chart-review/references/lifecycle.md` for the proposal →
  accepted → guideline-updated pipeline.

## Skill-specific references

- `references/proposal-schema.md` — full YAML schema for proposal files, with
  per-`change_kind` proposal body shapes (edge_case_add, keyword_set_add,
  code_set_revise, guidance_prose_revise, gate_revise, derivation_revise,
  exemplar_add)
- `references/clustering-heuristics.md` — step-by-step procedure for building
  the disagreement table, clustering by signal type, and selecting the right
  `change_kind`; includes the edit_reason code definitions and minimum-patient
  thresholds
- `references/examples.md` — two worked examples: a code-set trap and an
  ambiguous-guidance cluster, each with the full resulting proposal YAML

## Hard rules (with reasons)

- **Output goes ONLY to `proposals/<guideline-id>/`.** Never write to
  `guidelines/<id>/` — the guideline may be locked, and even for drafts,
  direct edits bypass the proposal review queue that the methodologist uses.
- **One cluster = one proposal.** Bundling unrelated edits makes it impossible
  for the methodologist to accept one change and reject another — keep them
  separate.
- **A proposal must cite specific motivating patients.** Without `motivating_patients`,
  the methodologist can't verify the rationale or trace the change back to
  evidence — the proposal becomes unauditable.
- **Don't propose edits that contradict `meta.overview_prose` intent.** A small
  edge-case fix that reverses the protocol's core definition is not a small fix;
  surface the deeper conflict to the methodologist instead.
- **If fewer than 3 disagreements on a criterion, treat as inconclusive.** Fewer
  than 3 motivating patients is noise, not a pattern; suggest more sampling
  rather than proposing a change that may be based on reviewer-specific
  preferences.

## Troubleshooting

**Most overrides are scattered (one per criterion, no clustering):** The cohort
is too small or too varied. End the session with: "I found N total overrides
across M criteria; nothing clusters with ≥3 supporting cases. I recommend
reviewing 20-30 more charts before proposing."

**Reviewer ground truth missing:** The patient was reviewed by the agent only;
reviewer never touched the answers. Flag those patients in your summary and
suggest the reviewer revisits them before running improvement.

**Proposals overlap (two would touch the same criterion):** If compatible
(e.g. one edge_case + one keyword_set for the same criterion), combine them
into separate proposal files but note the dependency in each `rationale`. If
they conflict (two competing guidance_prose rewrites), surface the conflict to
the methodologist rather than picking one.

## Verifying applied proposals

Once the methodologist accepts a proposal and the platform writes the
`applied` block on the proposal record, the platform exposes a verify
endpoint:

```
POST /api/proposals/:taskId/:ruleId/verify
```

It re-runs the targeted criterion on every patient that motivated the
proposal (the union of `trigger.patient_id` and `expected_outcome[].record_id`)
and returns per-patient `{ agent_answer, ground_truth, matches }`. If any
of those patients still don't match the captured ground truth, the
proposal didn't fully close its gap — recommend a follow-up proposal or
a guidance refinement before moving on.

(Note: the HTTP endpoint may be deferred pending a single-patient-single-
criterion rerun export; the underlying domain function is callable directly
from server-side code via `verifyProposalApplication` in
`app/server/domain/proposal/verify-application.ts`.)

## Iter graduation gates

Two further endpoints inform when a pilot can stop iterating and proceed
to lock-test:

- `GET /api/pilots/:taskId/regression-check?exclude=<iter_id>` — re-runs
  the agent on every patient validated in prior iters and returns any
  criterion-level disagreement against captured ground truth. Non-empty
  result returns HTTP 409 (gate blocked); the methodologist must either
  revert the offending change or promote the failing patient into a
  fresh iter sample for re-validation.

- `GET /api/pilots/:taskId/stop-rule` — reports whether the last two
  complete iters each landed with zero applied proposals. When yes, the
  guideline is considered settled and the methodologist should run
  `chart-review-calibrate` (held-out lock-test) before locking.
