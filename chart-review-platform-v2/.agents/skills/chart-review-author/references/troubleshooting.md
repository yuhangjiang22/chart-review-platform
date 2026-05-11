# Troubleshooting — chart-review-author

Common problems and fixes when drafting a new guideline package.

## Reviewer says the draft has too many criteria

**Cause:** drafted more than 12 criteria. v0 should be small and testable.

**Fix:** identify which criteria can be merged or which are derivable from
others. Make derivable ones into derived fields with a `derivation:` DSL
expression. Aim for 5-10 leaf criteria in v0. The reviewer can expand later
via `chart-review-improve`.

## Reference is paywalled / can't be fetched

**Fix:** ask the reviewer to paste the relevant section. Do not infer
criterion definitions from the article title or abstract alone.

## Two references conflict on the same definition

**Fix:** surface the conflict to the reviewer in your summary. Pick the
more recent / more clinically rigorous source as the default and document
the choice in `meta.overview_prose`. Note the alternative interpretation
so the reviewer can decide.

## User asks for a code set you can't confidently name

**Fix:** leave the criterion's `extraction_guidance` with a TODO comment:
`# TODO: confirm codes`. Do NOT seed `code_sets/<id>.yaml` with unverified
codes — incorrect code sets silently bias every downstream agent review.
Calibration will surface the gap; the reviewer can supply the codes then.
