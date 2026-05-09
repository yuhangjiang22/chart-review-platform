# Cluster 1 — smoke test against the real broken draft

Validator output when run against the actual `.claude/skills/drafts/chart-review-lung-cancer-who-has-it/` artifact produced during the 2026-05-07 test session.

## Result

The validator surfaces 4 diagnostics across the 4 criterion files:

- 3× `todo_marker_in_body` — `lung_cancer_clinical_mention.md`, `lung_cancer_pathology_present.md`, `lung_imaging_suspicious.md` (covers A6)
- 1× `criterion_schema_violation` — `lung_cancer_status.md` is `is_final_output: true` but lacks a `derivation:` block (covers B4)

The meta.yaml does NOT trigger a `meta_schema_violation` because it was manually patched mid-test session to a loader-shaped form (so the rest of the test cycle could proceed). B1 is exercised by the unit test against `lib/tests/fixtures/build-skill/known-bad-meta/meta.yaml`, which is the as-emitted broken meta verbatim from the build skill.

## Raw output

```
{
  "ok": false,
  "diagnostics": [
    {
      "code": "todo_marker_in_body",
      "path": ".../chart-review-lung-cancer-who-has-it/references/criteria/lung_cancer_clinical_mention.md",
      "message": "criterion body contains a # TODO marker; resolve before shipping"
    },
    {
      "code": "todo_marker_in_body",
      "path": ".../chart-review-lung-cancer-who-has-it/references/criteria/lung_cancer_pathology_present.md",
      "message": "criterion body contains a # TODO marker; resolve before shipping"
    },
    {
      "code": "criterion_schema_violation",
      "path": ".../chart-review-lung-cancer-who-has-it/references/criteria/lung_cancer_status.md",
      "message": "<root>: 'derivation' is a required property"
    },
    {
      "code": "todo_marker_in_body",
      "path": ".../chart-review-lung-cancer-who-has-it/references/criteria/lung_imaging_suspicious.md",
      "message": "criterion body contains a # TODO marker; resolve before shipping"
    }
  ]
}
```

## Acceptance

- Validator catches every bug class the cluster targeted (A6 + B4 demonstrated against real artifact; B1 demonstrated against fixture).
- The skill, after Task 8 lands, is now required to call `validate_package` and iterate until `ok: true` before declaring "Done." A future Builder run on a fresh task ID is the next-mile verification — out of scope for this cluster (deferred to Cluster 2 / Cluster 6 manual smoke).
