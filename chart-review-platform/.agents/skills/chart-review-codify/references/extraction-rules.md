# Codify extraction rules

## ID prefix conventions

- Codify-derived keyword sets: `kw_<field_id>`
- Codify-derived code sets: `codes_<field_id>`
- Hand-authored sets use any ID that doesn't start with `kw_` or `codes_`
  (e.g., `imaging_findings`, `pathology_terms`).

The prefix is how `update_uses_blocks` decides which entries to replace
on re-run. Hand-authored entries are preserved across codify runs.

## When a criterion does NOT get a keyword/code set

- The criterion is purely derived (`is_final_output: true` with `derivation`)
  and the reviewer never overrode it. Derived criteria roll up from leaves;
  there's no direct evidence to extract from.
- The criterion is `not_applicable` for every validated patient.
- The criterion has `evidence: []` on every reviewer-touched assessment.
  Common for criteria like `age_at_index` where the answer comes from a
  structured field the reviewer didn't pin as "evidence."

In all three cases, no artifact file is written and the `uses:` block is
left unchanged for that criterion.

## ICD prefix-grouping threshold

A prefix is emitted when ≥3 distinct leaves of the same parent appear in
the cohort. The threshold trades:

- Below 3: prefix groupings would emit on noise (e.g., one patient with
  `C34.10` + another with `C34.31` would generate `C34.x` even though the
  parent isn't well-represented).
- Above 3: misses real prefix patterns in small cohorts. Three is small
  enough to fire usefully on a 5-patient pilot, large enough to avoid noise.

The threshold lives in `lib/chart_review/codify_icd_prefix.py`.

## Top-N keyword cutoff

Each criterion's keyword set is capped at top 30 ranked terms. The cutoff
is empirical: most clinical anchor sets stabilize between 20 and 40 terms;
30 is a conservative middle that keeps file sizes small without losing
dominant phrases.

The threshold lives in `lib/chart_review/codify.py`.
