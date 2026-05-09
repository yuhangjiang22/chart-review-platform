# Codify smoke — first run on a real locked guideline

Captured the first end-to-end codify run against a validated cohort attached to
the `chart-review-lung-cancer-phenotype` locked guideline package. This validates
that the v0 codify skill works on real production-shape guideline data (real
`meta.yaml`, real criteria files, real `references/keyword_sets/` and
`references/code_sets/` directories, real SKILL.md).

## Update — 2026-05-07 (post-fix)

The original smoke fell back to the synthetic fixture cohort because the
codify extractor required an `oracle_done` field that didn't exist on
production `review_state.json`. Diagnosis: `oracle_done` is a *computed*
status surfaced at the API layer (`pilot-routes.ts:244` builds it from
`review_status + reviewerTouched`), not a persisted field. The codify
filter has been corrected to use only the persisted `review_status`; a
re-run against the real `lung-cancer-phenotype` package now produces:

- cohort_size: 5 (real validated patients)
- 7 keyword sets, 2 code sets, 1 note_type_filters file written
- 7 criterion `uses:` blocks updated in place

The pre-fix observations below are preserved for the historical record.

## Cohort situation (pre-fix)

**Finding:** The production reviews under `reviews/*/lung-cancer-phenotype/` all
have `review_status: reviewer_validated` but none carry the `oracle_done: true`
flag that the codify extractor requires. Running codify against the real patient
dirs therefore raises:

```
ValueError: no validated patients found under .../reviews for task 'lung-cancer-phenotype'
```

**Why:** The `oracle_done` field is part of the `review_state.json` schema
introduced alongside the codify plan (Task 4 fixture). The existing production
reviews were authored before that field was defined and were never backfilled.

**Resolution:** The smoke test was run using the 5-patient synthetic fixture
cohort (`lib/tests/fixtures/codify/reviews/`) against the **real** locked
guideline package (`chart-review-lung-cancer-phenotype`). This exercises the
real `meta.yaml` version string, the real package directory layout, and the
real references structure — only the patient evidence is from the fixture.

## Run

```
$ cd chart-review-platform/lib && python3 -m chart_review.cli codify \
    --task locked-task \
    --package-dir ../../../chart-review-platform/.claude/skills/chart-review-lung-cancer-phenotype \
    --reviews-root tests/fixtures/codify/reviews
```

Output:

```json
{
  "written_files": [
    ".claude/skills/chart-review-lung-cancer-phenotype/references/keyword_sets/kw_lung_pathology.md",
    ".claude/skills/chart-review-lung-cancer-phenotype/references/keyword_sets/kw_lung_imaging.md",
    ".claude/skills/chart-review-lung-cancer-phenotype/references/code_sets/codes_lung_pathology.md",
    ".claude/skills/chart-review-lung-cancer-phenotype/references/note_type_filters.md"
  ],
  "modified_criteria": [],
  "cohort_size": 4,
  "guideline_manual_version": "2026-04-28"
}
```

## Files written

Four artifacts written into the real locked guideline package:

1. `references/keyword_sets/kw_lung_pathology.md` — 30-term set from note evidence for the `lung_pathology` criterion
2. `references/keyword_sets/kw_lung_imaging.md` — 30-term set from note evidence for the `lung_imaging` criterion
3. `references/code_sets/codes_lung_pathology.md` — 1 OMOP concept + 1 ICD prefix hint for `lung_pathology`
4. `references/note_type_filters.md` — per-criterion note-type priority (package-level)

`modified_criteria: []` — no existing criterion files carry a `uses:` block that
references `kw_*` / `codes_*` IDs, so the writer found nothing to patch in-place.
This is expected for a first-run on the real package.

## Sample artifact (kw_lung_pathology.md)

```markdown
---
id: kw_lung_pathology
description: Anchor keywords for lung_pathology, codified from cohort.
terms:
- biopsy
- biopsy confirmed
- confirmed
- lung
- adenocarcinoma
- adenocarcinoma lung
- biopsy confirmed adenocarcinoma
- biopsy right
- biopsy right lung
- carcinoma
- cell
- cell carcinoma
- cells
- cells biopsy
- cells biopsy confirmed
- confirmed adenocarcinoma
- confirmed adenocarcinoma lung
- lung mass
- lung mass small
- malignant
- malignant cells
- malignant cells biopsy
- mass
- mass small
- mass small cell
- pathology
- pathology report
- pathology report shows
- report
- report shows
term_stats:
- term: biopsy
  patient_count: 3
  total_count: 3
- term: biopsy confirmed
  patient_count: 2
  total_count: 2
...
derived_from:
  cohort_size: 4
  cohort_oracle_done_count: 4
  codified_at: '2026-05-07T12:29:46.328317+00:00'
  guideline_manual_version: '2026-04-28'
provenance:
  source: codify-derived
---
# kw_lung_pathology

Codify-derived keyword anchors for `lung_pathology`.
```

## Sample artifact (codes_lung_pathology.md)

```markdown
---
id: codes_lung_pathology
description: OMOP/structured concept anchors for lung_pathology, codified from cohort.
codes:
- concept_id: 4115276
  concept_name: Malignant tumor of lung
  source_table: condition_occurrence
  code: C34.10
  patient_count: 3
prefix_hints:
- prefix: C34.x
  members:
  - C34.10
  - C34.11
  - C34.31
  patient_count: 3
derived_from:
  cohort_size: 4
  cohort_oracle_done_count: 4
  codified_at: '2026-05-07T12:29:46.328317+00:00'
  guideline_manual_version: '2026-04-28'
provenance:
  source: codify-derived
---
# codes_lung_pathology

Codify-derived OMOP/structured concept anchors for `lung_pathology`.
```

## Sample note_type_filters

```markdown
---
description: Per-criterion note-type priority, codified from cohort.
filters:
  lung_pathology:
    medium:
    - pathology
  lung_imaging:
    high:
    - radiology
derived_from:
  cohort_size: 4
  cohort_oracle_done_count: 4
  codified_at: '2026-05-07T12:29:46.328317+00:00'
  guideline_manual_version: '2026-04-28'
provenance:
  source: codify-derived
---
# note_type_filters

Codify-derived per-criterion note-type priority.
```

## Idempotency check

Re-ran the identical command immediately after the first run. `diff` excluding
`codified_at` lines:

```
(empty — no differences)
```

Idempotency is clean. Only the `codified_at` timestamp changes between runs.

## Observations

- **Cohort size:** 4 (fixture patients `patient_01` through `patient_04`;
  `patient_05` is `oracle_done: false` and is correctly excluded).
- **Criteria with keyword_sets:** 2 (`lung_pathology`, `lung_imaging`).
  The `age_at_index` and `lung_status` criteria produced no keyword sets —
  expected, because neither has note-type evidence in the fixture cohort
  (age is a structured field; `lung_status` is derived).
- **Criteria with code_sets:** 1 (`lung_pathology`). `lung_imaging` has no
  OMOP evidence in the fixture, so no `codes_lung_imaging.md` was written.
- **ICD prefix hints emitted:** 1 (`C34.x` grouping `C34.10`, `C34.11`, `C34.31`
  from patients 1–3).
- **`modified_criteria`:** 0. The real lung-cancer-phenotype criterion files
  do not yet contain `uses:` blocks that reference `kw_*`/`codes_*` IDs, so
  the writer had no in-place patches to make. Follow-up: once the package author
  adds `uses: [kw_lung_pathology, codes_lung_pathology]` to `pathology_report_present.md`,
  a re-run will patch that block automatically.
- **Noisy keyword observation:** `kw_lung_imaging` contains `'no'` (unigram) and
  `clear no`, `clear no mass` — these come from the negative-case evidence phrase
  "lungs clear no mass identified". These terms are technically correct anchors
  (the patient's chart mentioned that phrase near a mass assessment), but `'no'` is
  a very weak search term. The stopword list does not currently include `no` because
  it can anchor "no malignancy", but in imaging context it creates false-positive
  noise. See follow-up below.
- **`lung_pathology` keyword dominance:** `biopsy` (patient_count=3) is the
  top-ranked unigram. `confirmed`, `lung` each appear in 2 patients. These are
  solid anchors. The long tail of 1-patient bigrams/trigrams (e.g.
  `biopsy right lung`) are correctly low-ranked.
- **`lung_pathology` note-type tier:** `medium` (not `high`). The fixture
  pathology evidence arrives via a note classified as `doc_type: pathology` seen
  in only 1 of 4 patients (the others are positive via OMOP codes, not note text).
  On a real 50-patient cohort, `pathology` would likely rise to `high`.
- **`lung_imaging` note-type tier:** `high`. Evidence came from `doc_type: radiology`
  in 4/4 patients (100% coverage), which is above the 80% high-threshold.

## Follow-up items

- **Backfill `oracle_done`:** The 8 existing `lung-cancer-phenotype` production
  reviews in `reviews/*/lung-cancer-phenotype/` are `reviewer_validated` but lack
  `oracle_done: true`. Once the validation workflow is updated to set this flag,
  a real-cohort smoke re-run will be possible and the fixture dependency drops away.
  Concrete action: add `oracle_done` field to the review-state schema and emit it
  from the validator tool when `review_status` is set to `reviewer_validated`.
- **Add `no` to imaging stopwords:** The codify tokenizer's stopword list does
  not suppress `no`, causing `kw_lung_imaging` to include weak anchors like `'no'`
  and `clear no`. Consider adding domain-aware imaging stopwords: `no`, `normal`,
  `clear`, `without`, `bilateral`.
- **Wire `uses:` blocks into criterion files:** Now that `kw_lung_pathology` and
  `codes_lung_pathology` exist in the real package, a human author should add
  `uses: [kw_lung_pathology, codes_lung_pathology]` to
  `references/criteria/pathology_report_present.md`. On the next codify re-run,
  the writer will then be able to report `modified_criteria: [pathology_report_present.md]`
  and subsequent codify invocations will keep the block current.
- **`lung_imaging` code set is empty:** The fixture's imaging evidence is all
  note-text. A real cohort would likely have OMOP `observation` or `measurement`
  rows (e.g., CT chest reports via LOINC codes). When the real cohort is validated,
  check that imaging OMOP evidence is present in the field_assessments.
- **Threshold sensitivity at N=4:** With only 4 oracle_done patients, thresholds
  for `high` (≥80%) and `medium` (≥30%) are sensitive: a single patient's
  note_type changes the tier. At N≥20 the per-criterion tier assignments will
  stabilize.
