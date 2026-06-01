---
name: migration
description: Apply a new SKILL bundle SHA to past locked records by archiving each affected record and reopening it for re-review. Use when a guideline change requires re-evaluating previously locked decisions under the new rules.
---

# Migration

Targeted re-run of locked records under a new SKILL bundle version.

## How it works (today)

Implemented as `app/server/migration.ts`. Called from the Studio MigrationPanel after impact simulation.

## Future externalization

Out of scope for batch E.0.
