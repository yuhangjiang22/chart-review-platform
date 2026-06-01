---
name: chart-review-ner-cohort
description: >
  Analyzes a deployed NER task across a production cohort to detect
  drift, surface override patterns per entity_type, and track
  novel_candidate rate trending. Use when the user says "any drift on
  the bso-ad task", "is the NER guideline still working", "cohort
  feedback for NER", "novel_candidate rate over time", or asks for
  periodic quality assurance on a locked NER task. Outputs a feedback
  report with detected drift, clustered override patterns per
  entity_type, and pointers to issues that warrant a
  chart-review-ner-improve proposal or chart-review-ner-ontology-extend
  promotion. Does not propose edits itself — surfaces findings only.
metadata:
  version: 0.1
---

# NER cohort drift skill

Read-only periodic QA. Computes:

1. **Per-entity-type override rate** in rolling 50-review windows.
   Baseline = first 50 reviews after lock. Flag any window where override
   rate exceeds baseline by ≥10 percentage points.
2. **Novel-candidate rate trending.** Rising = ontology gap; route the
   pattern into `chart-review-ner-ontology-extend`.
3. **Per-entity-type concept distribution.** Drift in which concept_names
   get assigned within a subtree (e.g. shift from `Female` to `Male`
   over time) suggests either real cohort change or a labeling
   regression.
4. **Boundary jitter rate.** Cohort-level boundary disagreement
   trending — climbing rates suggest the annotation guidance for
   span-bounds needs an `anchor_hints` proposal.

Writes the report to `cohorts/<task-id>/feedback.json` + a sibling
`feedback.md` for human reading. The report does NOT propose edits —
it just identifies which signals are worth routing into
`chart-review-ner-improve` or `chart-review-ner-ontology-extend`.

## Hard rules

- **No write side effects on the task or ontology.** Only the
  `cohorts/<task-id>/` artifacts get written.
- **Cite by patient + span_id.** Every flagged pattern in the report
  should reference at least 3 example spans.
- **Stay measurement-focused.** If you find a problem, describe it
  precisely; do not prescribe the fix (that's the improve / ontology-
  extend skills' job).
