# chart-review-codify — design

A new skill that takes (locked guideline + validated cohort) and mechanically generates efficiency artifacts — keyword sets, code sets, and note-type filters — that the chart-review skill uses at runtime to narrow its search space on subsequent patients.

## Why

The reviewer's authoring workflow is **discover-then-codify**:

1. **Drafting** — define criteria + decision rules. **Do not** specify data sources, keyword lists, code sets, or note-type filters. Information leaks across documents; authors can't enumerate sources upfront without under- or over-fitting.
2. **Pilot** — run reviews comprehensively. The agent + reviewer look at all notes and all structured data; no filtering. This builds the validated cohort.
3. **Codification** — once a manually-validated cohort + locked guideline exist, mechanically generate `keyword_sets/`, `code_sets/`, and `note_type_filters` from the validated evidence. These artifacts attach to the locked guideline as efficiency aids for subsequent agent runs.

The artifacts are **disposable efficiency hints**, not part of the locked record. They get regenerated as cohorts grow. They serve subsequent agents — fresh patients reviewed under the same guideline don't need the agent to read every note in every chart, only the candidate notes the empirical evidence pattern points at.

## Scope

### In scope (v0 / Tier 1)

Three artifact families:

- `references/keyword_sets/kw_<field_id>.yaml` — one per criterion that had reviewer-flagged note evidence
- `references/code_sets/codes_<field_id>.yaml` — one per criterion that had reviewer-flagged OMOP-row evidence
- `references/note_type_filters.yaml` — one package-level file with per-criterion priority lists

### Out of scope (Tier 2/3 future work)

- LLM consolidation pass (synonym grouping, abstraction)
- Negation / exclusion patterns
- Section-of-note filters (within long notes, which `## Heading` sections to prioritize)
- Criterion difficulty signals (override rate, latency)
- Empirical time-window calibration
- Auto-trigger on lock
- Streaming progress UI

These are deferred until Tier 1 ships and real use surfaces actual gaps.

## Triggers and surfaces

### Trigger
**On-demand only.** Invoked from the LOCK phase panel ("Codify artifacts" button) or via the `/codify` slash command. Not auto-run on lock — the reviewer stays in control.

Re-running is cheap (deterministic; same inputs → same outputs), so there's no penalty for invoking repeatedly as the cohort grows.

### Surfaces

| Surface | Purpose |
|---|---|
| `.claude/skills/chart-review-codify/SKILL.md` | Skill activation; matches the existing skill style (chart-review-improve, chart-review-calibrate) |
| `lib/chart_review/codify.py` | Deterministic extractor; pure Python; testable in isolation |
| `POST /api/guideline-codify/:taskId` | Server route that invokes the skill and returns `{ written_files: [...], cohort_size: N }` |
| LOCK panel UI button | "Codify artifacts" + status badge (last_codified_at, current vs stale) |

## Inputs

### Locked guideline
- `.claude/skills/chart-review-<task>/meta.yaml` with `status: locked`
- All criteria under `references/criteria/*.md` (markdown frontmatter format per cluster 1)

### Validated cohort
- All patients under `reviews/<patient>/<task>/review_state.json` where:
  - `review_status` ∈ {`reviewer_validated`, `locked`}
  - `oracle_done == true` (the official validation flag)
- Field assessments where `updated_by == "reviewer"` are the ground-truth evidence anchors. Agent-only assessments are excluded — they may carry the reviewer's eventual override but were not the "right" evidence.

## Extraction (deterministic)

For each validated review, walk:
- `field_assessments[].evidence[]` (per-criterion evidence)
- `selected_evidence[]` (free-floating evidence with optional `field_id`)

For each evidence row:
- **note source** → tokenize `verbatim_quote` (1-, 2-, 3-grams; lowercase; strip punctuation; drop English stopwords); attribute to the criterion's `field_id`.
- **omop source** → record `{concept_id, concept_name, value, source_table}`; attribute to the criterion.
- **note metadata** → look up the note's type from the corpus's note catalog; attribute to the criterion.

### Aggregation

**keyword_sets:**
- Rank n-grams by patient-coverage descending: a term in 5 different patients beats a term that appeared 20 times in 1 patient.
- Cap at top 30 per criterion.
- Output entries: `{term: <string>, patient_count: <n>, total_count: <n>}`.

**code_sets:**
- Dedupe concept_ids; group by source table (`condition_occurrence`, `drug_exposure`, `measurement`, etc.).
- Output entries: `{concept_id, concept_name, source_table, patient_count}`.
- **Concept-hierarchy hints:** when ≥3 leaves of the same ICD-10 parent appear (e.g., `C34.10`, `C34.11`, `C34.31`), emit a parent-prefix hint `{prefix: "C34.x", patient_count: <n>}` alongside the literal codes. Pure prefix grouping; no LLM.

**note_type_filters:**
- Per-criterion ranked list of note types by patient-coverage.
- Flag types covering ≥80% of patients with `priority: high`, ≥30% with `priority: medium`, rest implicit (`priority: low`).
- Output is a single package-level YAML keyed by `field_id`.

## Output format

Each YAML carries a `derived_from` block for invalidation:

```yaml
# references/keyword_sets/kw_lung_cancer_pathology_present.yaml
id: kw_lung_cancer_pathology_present
description: "Anchor keywords for lung_cancer_pathology_present, codified from cohort"
derived_from:
  cohort_size: 18
  cohort_oracle_done_count: 18
  codified_at: "2026-05-07T18:42:00Z"
  guideline_manual_version: "0.4.0"
keywords:
  - { term: "biopsy", patient_count: 12, total_count: 27 }
  - { term: "pathology report", patient_count: 11, total_count: 19 }
  - { term: "spiculated", patient_count: 8, total_count: 11 }
  ...
```

```yaml
# references/code_sets/codes_lung_cancer_pathology_present.yaml
id: codes_lung_cancer_pathology_present
description: "OMOP concept anchors for lung_cancer_pathology_present"
derived_from: { ... }
codes:
  - { concept_id: 4115276, concept_name: "Malignant tumor of lung", source_table: "condition_occurrence", patient_count: 9 }
  - { concept_id: 4115277, ..., patient_count: 7 }
  ...
prefix_hints:
  - { prefix: "C34.x", source_table: "condition_occurrence", patient_count: 11 }
```

```yaml
# references/note_type_filters.yaml
description: "Per-criterion note-type priority, codified from cohort"
derived_from: { ... }
filters:
  lung_cancer_pathology_present:
    high:    [pathology, oncology_consult]
    medium:  [discharge_summary, progress_note]
  lung_imaging_suspicious:
    high:    [radiology]
    medium:  [oncology_consult, ed_note]
  ...
```

## Wiring at runtime

The chart-review skill's existing criterion frontmatter `uses:` block already supports referencing keyword sets and code sets by ID:

```yaml
uses:
  keyword_sets: [kw_lung_cancer_pathology_present]
  code_sets:    [codes_lung_cancer_pathology_present]
```

The codify skill writes the new artifact files AND **adds** their IDs to each criterion's `uses.keyword_sets[]` / `uses.code_sets[]` arrays. Add, don't replace — any pre-existing manually-authored references survive. Codify-generated artifacts use a `kw_*` / `codes_*` ID prefix so they're distinguishable from hand-authored ones; on subsequent codify runs, only entries with these prefixes are replaced.

For `note_type_filters` (the package-level file), the chart-review skill's loader needs a small extension to read the file and surface filters per-criterion at agent runtime. This is a localized change to `loadPhenotypeCriteria` (or a sibling loader).

**Implementation note:** The criterion-file schema and loader already accept `uses.keyword_sets[]` and `uses.code_sets[]`, and the existing `loadKeywordSets` / `loadCodeSets` helpers already read from `references/keyword_sets/` and `references/code_sets/`. What's not yet wired is the agent's *runtime use* of these sets to narrow its search — the chart-review skill's prompt / tool calls don't currently surface the keyword/code anchors when answering. The codify skill produces correct artifacts; the chart-review skill needs a parallel update to actually consume them. Treat the chart-review-skill update as a co-required follow-up cluster (call it cluster 1.5 — "agent uses codified artifacts at runtime"). Codify v0 is well-defined without it; it just doesn't accelerate anything until the consuming side lands.

## Composition with `chart-review-improve`

Both skills read the validated cohort. They produce different outputs:

- **chart-review-improve** → `proposals/<task>/<id>.yaml` (guideline-edit proposals; require reviewer approval; modify the guideline itself).
- **chart-review-codify** → `references/{keyword_sets,code_sets,note_type_filters}/...yaml` (efficiency artifacts; attach to the locked guideline; don't modify it).

They can run in parallel and don't interact. Codify is post-lock; improve is pre-lock (during iter loop). After lock, codify is the only one that should touch the locked guideline (improve cannot — locked is locked).

## Invalidation

Each artifact carries `derived_from.guideline_manual_version`. When the guideline's `manual_version` changes (revise → new lock cycle), a fresh codify run produces new artifacts.

Stale artifacts (where `derived_from.guideline_manual_version != current_manual_version`) get a UI badge "Stale — regenerate" on the LOCK panel. They aren't auto-deleted — the reviewer can compare old vs new before regenerating.

## Failure modes

| Condition | Behavior |
|---|---|
| Cohort has 0 oracle_done patients | Skill refuses with error "no validated patients to codify from". |
| Cohort smaller than 3 patients | Skill warns "artifacts may not generalize; cohort_size=N", but still produces them. The reviewer chooses whether to use them. |
| A criterion has zero reviewer-flagged evidence | No keyword_set or code_set emitted for that criterion; its `uses:` block stays unchanged. Common for derived criteria the reviewer never overrode. |
| OMOP `concept_name` lookup fails (concept_id not in vocab) | Emit the entry with `concept_name: "(lookup failed)"`; don't drop the row. |
| Note-type metadata missing for a note_id | Bucket as `note_type: unknown`; emit a warning in the codify run summary. |

## Tests

| File | What it tests |
|---|---|
| `lib/tests/test_codify_extractor.py` | Unit tests on a synthetic cohort fixture (5 patients × 4 criteria reviews) → expected keyword/code/note-type artifacts. Per-criterion + per-aggregation-rule. |
| `lib/tests/test_codify_invalidation.py` | Synthetic cohort run twice with different `manual_version`s → artifacts get new `derived_from`; stale-badge logic operates on the right comparison. |
| `app/server/__tests__/codify-route.test.ts` | POST `/api/guideline-codify/:taskId`: refuses empty cohort with 400; produces expected `{written_files, cohort_size}` shape on a happy-path fixture. |
| `app/server/__tests__/codify-uses-block.test.ts` | After codify run, the criterion files' `uses:` blocks reference the new artifact IDs. |
| `app/client/src/__tests__/CodifyButton.test.tsx` | LOCK panel button states (idle / running / stale / clean). |
| E2E (smoke) | Lock a fixture guideline → run codify → verify artifact files written + criterion `uses:` blocks updated → simulate a chart-review run picking up the artifacts via `uses`. |

## Files to create / modify

| File | Action |
|---|---|
| `chart-review-platform/.claude/skills/chart-review-codify/SKILL.md` | Create — skill activation prose; matches the chart-review-improve / chart-review-calibrate style |
| `chart-review-platform/.claude/skills/chart-review-codify/references/...` | Create — extraction-rule docs, edge-case notes |
| `chart-review-platform/lib/chart_review/codify.py` | Create — pure-Python deterministic extractor |
| `chart-review-platform/contracts/keyword_set.schema.json` | Create — JSON Schema for the new YAML shape (or extend existing if there's already a partial) |
| `chart-review-platform/contracts/code_set.schema.json` | Create |
| `chart-review-platform/contracts/note_type_filters.schema.json` | Create |
| `chart-review-platform/app/server/codify.ts` | Create — TS wrapper that shells out to the Python extractor |
| `chart-review-platform/app/server/adapters/http/codify-routes.ts` | Create — HTTP endpoint |
| `chart-review-platform/app/server/server.ts` | Modify — register the new router |
| `chart-review-platform/app/server/domain/rubric/phenotype-skill.ts` | Modify — extend the loader to surface `note_type_filters.yaml` per-criterion |
| `chart-review-platform/app/client/src/ui/Workspace/PhaseLock.tsx` (or wherever LOCK lives) | Modify — add the "Codify artifacts" button + status |
| Fixtures and tests as listed above | Create |

## Acceptance

1. New skill activates correctly when the user says "codify the artifacts" or invokes `/codify` from a locked guideline.
2. Running codify on the existing `lung-cancer-phenotype` cohort (which is already locked at 8 pilot iterations) produces:
   - At least one keyword_set and one code_set per criterion that had ≥1 reviewer-flagged evidence row
   - A populated note_type_filters.yaml
   - Each criterion's `uses:` block updated to reference the new artifact IDs
3. The chart-review skill, on a fresh patient against the post-codify locked guideline, surfaces the artifact-narrowed search at runtime (the agent's logged actions show keyword/code/note-type filtering).
4. All new tests pass; no regressions to the 770+ existing TS tests or 35+ Python contracts tests.
5. A re-run with the same inputs produces byte-identical artifact files (reproducibility check).

## Out-of-scope follow-ups (post v0)

- **Tier 2:** negation_patterns, section_filters — improve agent accuracy not just speed.
- **Tier 3:** criterion_difficulty, empirical_time_windows — cohort-level calibration signals.
- **LLM consolidation** — only if v0 keyword sets prove too noisy in real use.
- **Auto-trigger on lock** — only if reviewers consistently regenerate immediately after lock anyway.
