---
name: chart-review-ner-calibrate
description: >
  Pre-lock calibration for a draft NER task. Samples patient charts,
  drives dual-blind annotation runs (two reviewers — typically an agent
  pair, or one agent + one human), computes per-entity-type F1 +
  tuple-κ via @chart-review/eval-span-iaa, and reports whether each
  entity_type clears the lock threshold. Use when the user says
  "calibrate this NER draft", "is this NER task ready to lock",
  "compute F1 per entity_type", "validate the ontology coverage",
  "run an NER calibration sample", or asks to gate locking on agreement
  metrics. Reports per-entity-type F1 with Landis–Koch-adapted buckets,
  surfaces the boundary / type / concept disagreements, writes a
  calibration report. Acts as the release gate between draft and locked.
metadata:
  version: 0.1
---

# NER calibration skill

You are computing inter-annotator agreement for an NER task before it
locks. This is the NER analogue of `chart-review-calibrate` (which
computes per-criterion Cohen's κ for phenotype tasks). The math is
different — span IAA uses tuple-match + IoU fallback (F1 metric), not
exact cell agreement.

## Inputs you receive

| Item | Notes |
|---|---|
| `task_id` | The NER task to calibrate |
| `iter_id` | Which pilot iteration to draw spans from |
| Optional `min_sample` | Floor for per-entity-type sample size (default 30 spans) |

## Workflow

1. Locate the pilot iter's per-agent drafts at
   `runs/<iter.run_id>/per_patient/<pid>/agents/<agent>.json` —
   filter to two-or-more-agent runs (1-agent NER iters are not
   calibratable; surface that as an error).
2. For each patient, load the two reviewer-comparable annotators'
   span lists (typically agent_1 + agent_2 in a dual-blind iter,
   OR agent_1 + human_oracle.json if the reviewer pane has been
   used).
3. Call `computeSpanIaa(spansA, spansB)` from
   `@chart-review/eval-span-iaa` for each patient, accumulate per-
   entity-type counters across patients.
4. Compute aggregate metrics:
   - **precision / recall / F1** per entity_type
   - **macro F1** across entity_types (the headline number)
   - **tuple κ** (exact-match agreement, a stricter floor)
5. Bucket per-entity-type F1 against the NER-adapted Landis–Koch
   thresholds (recommend in the report):
   - F1 ≥ 0.81 → excellent (lock-ready)
   - 0.61–0.80 → substantial
   - 0.41–0.60 → moderate (consider chart-review-ner-improve)
   - 0.21–0.40 → fair (NOT lock-ready)
   - < 0.21 → poor (NOT lock-ready)
6. Write `calibration/<task-id>/<run-id>/{raw.json, report.md}`:
   - `raw.json` — the full SpanIaaReport + per-pair tallies
   - `report.md` — human-readable per-entity-type bucket assignment +
     lowest-F1 spans cited as exemplars + a final "lockable Y/N"
     verdict
7. Emit a short summary to stdout + the path of the written report.

## Output schema

```yaml
# raw.json
task_id: bso-ad-ner
iter_id: <iter>
run_id: <run>
generated_at: <iso>
per_entity_type:
  - entity_type: Demographic
    agree: 12
    miss_only_a: 1
    miss_only_b: 2
    soft_or_boundary: 1
    precision: 0.857
    recall: 0.800
    f1: 0.828
    bucket: substantial
    bucket_threshold: 0.61
    sample_size: 16
macro_f1: 0.74
tuple_kappa: 0.68
verdict: not_lockable   # any entity_type below 0.61 fails the gate
```

## Hard rules

- **Two-or-more annotators required.** Single-agent iters cannot be
  calibrated; surface that error and stop.
- **Cite spans.** The report's per-entity-type section should reference
  3–5 example span_ids per disagreement kind so a reviewer can audit
  the calls.
- **No commits.** This is a measurement skill — never modify the task
  or its ontology. Failures route into `chart-review-ner-improve` (for
  annotation guidance) or `chart-review-ner-ontology-extend` (for
  ontology promotions).
- **F1 thresholds, not κ thresholds.** The Landis–Koch κ buckets
  (0.0/0.2/0.4/0.6/0.8) don't translate 1:1 to F1. Use the F1-adapted
  buckets above and cite that they are NER-specific in the report.
