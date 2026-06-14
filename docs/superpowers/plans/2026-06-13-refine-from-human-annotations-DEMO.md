# EA2 demonstration — refine-from-human-annotations, end-to-end (2026-06-13)

A real run of the whole loop on a constructed-but-genuine rubric gap. The gap is
real (the `cancer_type` enum has no rule for **mixed histology**); the model
error, the error-analysis attribution, the proposed rule, and the held-out Δ are
all produced live (claude-sonnet via the deepagents provider).

## Fixture cohort (session_026 / iter_039)
5 patients, `cancer-diagnosis`, 1 agent (default). Human annotation =
predominant-component convention (`adenocarcinoma` for adenosquamous).

| patient | histology in chart | model | human (gold) | split |
|---|---|---|---|---|
| patient_test_adenosq_01 | adenosquamous 60/40 | `other` | adenocarcinoma | held-out |
| patient_test_adenosq_02 | adenosquamous 70/30 | (agent errored) | adenocarcinoma | refine |
| patient_test_adenosq_03 | adenosquamous 55/45 | `other` | adenocarcinoma | **refine** |
| patient_test_adenosq_04 | adenosquamous 65/35 | `other` | adenocarcinoma | held-out |
| patient_easy_nsclc_02 | pure squamous | `squamous_cell_carcinoma` | squamous_cell_carcinoma | held-out (no-regression control) |

All 5 agreed/validated; the 3 adenosquamous mismatches are agent-agrees-with-itself
(both agents on adenosq_01 said `other`) → invisible to the agent-vs-agent judge.

## The loop, step by step (live API)
1. `POST /api/refine/cancer-diagnosis/iter_039/analyze-errors` → **3 cells analyzed**,
   all `genuine_ambiguity → true_ambiguity`. The pass explicitly judged the model's
   `other` *defensible* under the current rubric (NOT a model_slip) — it attributes
   the failure to the rubric, not the model.
2. `POST …/propose {field_id: cancer_type}` → the transparent card:

```
① adenosq_03: model "other" / human "adenocarcinoma"  [true_ambiguity]   (refine_n=2)
② The criterion's mapping table only covers pure histologic types and provides no
   instruction for mixed or combined histologies (e.g. adenosquamous carcinoma).
③ "Mixed/combined histologies: When a pathology report documents a tumor with
   components of two or more named histologic types (e.g. 'adenosquamous carcinoma',
   'combined small cell and adenocarcinoma'), map to the enum value corresponding to
   the predominant or first-named component as stated in the pathology report. If the
   report does not indicate predominance, map to the component that appears first in
   the diagnosis. Do NOT use `other` solely because the combined term is not listed
   verbatim in the mapping table."
   (leakage scan: clean)
④ held-out Δ = +0.667 : agreement_old 0.333 → agreement_new 1.0,
   n_fixed=2, n_regressed=0, heldout_n=3, scored_n=3
```

The proposed rule fixed both held-out adenosquamous patients (`other`→`adenocarcinoma`)
under a candidate rubric and did NOT regress the pure-squamous control — the
generalization proof v2's open loop never computes.

## What this validates
- Attribution from the **model-vs-human** comparison works where the agent-vs-agent
  judge is structurally blind (both agents wrong the same way).
- The error analyst distinguishes a rubric problem from a model slip.
- The refiner writes a **generalizable** rule (predominant-component), not a
  patient lookup; leakage scan clean.
- Held-out Δ gates the edit with a real number (+0.667, 0 regressions).
- Human still applies the card (the Apply button appends ③ to the criterion).

## Remaining (EA2 UI wiring)
The PERFORMANCE-page Refine affordance (PhaseDecide) predates EA1: it offers
"run JUDGE" for unjudged cells and only routes `guideline_gap`. To surface this
in the UI it needs (a) an "Analyze errors" action (POST /analyze-errors) for
unjudged mismatch cells, and (b) to route `true_ambiguity` to "Propose rule"
like `guideline_gap`.
