---
name: chart-review-codify
description: >
  Generates efficiency artifacts (keyword sets, code sets, note-type filters) from
  a locked guideline + its validated cohort. Use when the user says "codify the
  artifacts", "generate keyword sets", "extract code anchors from cohort", "speed
  up the agent for next runs", or after locking a guideline and wanting to make
  subsequent agent runs cheaper. Writes to references/{keyword_sets,code_sets,note_type_filters}/
  on the locked guideline; updates each criterion's `uses:` block to reference
  the new artifacts. Composes with chart-review-improve (which produces guideline
  edit proposals; codify produces static reference artifacts) and runs
  post-lock — never modifies guideline shape.
metadata:
  author: chart-review-platform
  version: "0.1.0"
---

# Chart Review Codify

Mechanically extracts efficiency artifacts from a locked guideline + validated
cohort. The artifacts narrow the agent's search space on subsequent patients:
keyword sets seed text searches over notes; code sets seed OMOP queries;
note-type filters prioritize which notes to read first.

## When to use

- User says "codify the artifacts", "generate keyword sets", "speed up the agent",
  "extract anchors from the cohort", "regenerate codify artifacts"
- After locking a guideline, when ready to ship efficiency hints for subsequent agents
- After a revise → re-lock cycle that bumps `manual_version` (artifacts go stale)

## Inputs

- **package_dir**: `.claude/skills/chart-review-<task>/` (must have `meta.yaml` `status: locked`)
- **reviews_root**: usually `chart-review-platform/reviews/` — walked for
  `<patient>/<task>/review_state.json` files where `oracle_done == true` AND
  `review_status` ∈ {`reviewer_validated`, `locked`}
- **task_id**: matches the per-patient subdirectory

## Procedure

1. **Read the locked guideline.** `<package_dir>/meta.yaml` and
   `<package_dir>/references/criteria/*.md`. Confirm `status: locked`.

2. **Walk the validated cohort.** Filter to oracle_done + reviewer_validated/locked
   patients. Skip everything else — agent-only proposals are not ground truth.

3. **Run the extractor.** Use `chart_review.codify.codify(...)` or
   `python3 -m chart_review.cli codify --task <id>`. The extractor produces:
   - `keyword_sets/kw_<field_id>.md` — top-30 n-grams ranked by patient-coverage
   - `code_sets/codes_<field_id>.md` — OMOP concept_ids + ICD prefix hints (≥3 leaves)
   - `note_type_filters.md` — per-criterion note-type priority (high/medium/low)

4. **Update `uses:` blocks.** Add the new artifact IDs to each criterion's
   `uses.keyword_sets[]` / `uses.code_sets[]`. Hand-authored entries (those
   NOT starting with `kw_` / `codes_`) are preserved.

5. **Report to the user.** List the files written, the cohort size, and the
   guideline manual_version stamped into `derived_from`.

## Hard rules (with reasons)

- **Only oracle_done == true patients count.** Agent-proposed-but-not-validated
  evidence isn't ground truth; including it would propagate agent biases into
  the artifacts.

- **`uses:` block updates ADD; never silently DELETE hand-authored entries.**
  Codify's role is to layer derived hints on top of the reviewer's authored
  references. A hand-authored `kw_pathology_terms` entry survives codify runs.

- **Re-running with the same inputs is safe.** The `derived_from` block carries
  the cohort signature; the agent's actual output is byte-deterministic apart
  from the `codified_at` timestamp.

- **Refuse if cohort is empty.** Zero oracle_done patients → exit with
  `ValueError: no validated patients found`. Don't write empty artifacts.

- **Codify is post-lock.** Drafts (`status: draft`) shouldn't be codified —
  the artifacts would invalidate as soon as the draft revised. The skill
  doesn't enforce this hard, but the SKILL.md guidance + UI button gating
  keep the user honest.

## See also

- `references/extraction-rules.md` — when to expand a criterion's `uses:`,
  ID-prefix conventions, ICD prefix-grouping threshold rationale.
- `chart-review-improve` — produces guideline edit proposals from the same
  cohort. Codify is parallel; runs post-lock; doesn't modify guideline shape.
