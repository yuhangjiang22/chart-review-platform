---
name: version-diff
description: Compute a per-field semantic diff between two SKILL bundle versions; report added, removed, changed, and unchanged criteria with payload-level diffs for guidance, gates, schemas, and derivations. Use to surface what changed between two locked task SHAs.
---

# Version Diff

Diffs two SKILL bundle versions and reports field-level changes.

## How it works (today)

Implemented as `app/server/task-diff.ts`. Called by the methodologist's RevisionHistoryView and by the impact-simulator.

## Future externalization

Out of scope for batch E.0.
