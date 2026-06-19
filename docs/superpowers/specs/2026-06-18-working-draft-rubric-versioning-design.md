# Working-Draft Rubric Versioning — Design

**Date:** 2026-06-18
**Status:** approved (design), pending implementation plan
**Supersedes part of:** `2026-06-15-session-scoped-rubric-versioning-design.md`
(version *creation timing*; the fork/switch/promote machinery is unchanged)

## Goal

Decouple **editing the rubric** from **snapshotting a version**. Today every
apply, author edit, and revert auto-snapshots a version, so N refinement
proposals from one run produce N versions — a noisy, per-keystroke timeline —
and two undo mechanisms (per-refinement revert vs. version switch) that create
competing version chains and can contradict each other. After this change, edits
flow into a **working draft**; versions are snapshots taken only at meaningful
moments (an explicit checkpoint, or automatically before a run). This gives
user-meaningful, citable versions and a single source of truth.

## Background — current behavior and the problem

A session forks the baseline rubric into `sessions/<sid>/rubric/` (the
*working copy* = `references/`) plus a `versions/` timeline with a movable
`active` pointer (see the 2026-06-15 design). Currently:

- `applyRefinement` / `applyAdherenceRefinement` write the criterion/question in
  the working copy **and** call `snapshotAfterEdit` → a new `refine:<field>`
  version.
- The AUTHOR-pane PUT writes the working copy **and** snapshots an `author-edit`
  version.
- `revertRefinement` / `revertAdherenceRefinement` restore the prior text **and**
  snapshot a `revert:<field>` version.

Consequences this design fixes:
1. **Timeline noise** — N applies → N versions.
2. **Two competing undo paths** — per-refinement revert (surgical, per field,
   destructive on intervening edits) and version-switch (whole-rubric,
   non-destructive). They don't update each other's state: switching versions
   doesn't mark refinement-log entries reverted, and revert stacks a new version
   rather than moving `active` back.
3. **No entry↔version link** — a refinement-log entry records no `version_id`.

## Design — the working-draft model

Think of the session fork like a **git working tree**:

- The **working draft** is the live `references/` tree. All edits land here.
- The **version timeline** holds snapshots; `active` is the last snapshot the
  draft was materialized from. The draft may *diverge* from `active`
  (uncommitted changes) — this is new and intended.

### What edits the draft (NO version created)

| Action | Effect on draft | Other effects |
|---|---|---|
| **Apply** a refinement | rewrites that criterion/question's text | writes a refinement-log entry (audit trail, unchanged) |
| **Author-pane edit** | rewrites the edited fields | none (matches today's "not logged to provenance") |
| **Revert** a logged refinement | restores that criterion's pre-apply text | marks the log entry `reverted`; sets `intervening_edit` if the field changed since |

These three **no longer call `snapshotAfterEdit`**. The session-scoped *targeting*
introduced on 2026-06-18 (apply/revert/author-edit resolve the session fork via
`resolveRubricRoot(taskId, sessionId)`, never the baseline) is **retained** — only
the snapshot call is removed.

### What creates a version (TWO triggers)

1. **"Create version" button** — snapshots the current draft with a user note as
   the `source` (default auto-summary, e.g. `"3 refinements since v2"`). No-op
   (dedup) if the draft is identical to `active`.
2. **"Try on patients" (run start)** — if the draft differs from `active`,
   auto-snapshot a version with `source: run:<iterId>` *before* the run records
   its rubric provenance, so every run cites a real version SHA. If the draft is
   unchanged, reuse `active` (content-SHA dedup → no churn).

Net: **versions = states that were run or explicitly saved**, never one per edit.

### Run provenance

The run already reads the fork's working copy (`resolveRubricRoot(taskId,
session_id)`) and records the active version via `getActiveVersion(...)`. We add a
**snapshot-if-dirty** step at run start: if the working draft's content-SHA differs
from `active`, call `snapshotVersion` first so `active` catches up, then record it.
This closes the provenance gap (a run on an uncommitted draft would otherwise cite
a stale version).

### Revert vs. version-switch (the inconsistency, resolved)

One source of truth — the draft — with two distinct, non-competing operations:

- **Revert** (refinement-log, draft-level): surgically undo *one* applied
  refinement, keeping other applies in the draft. This is the only way to drop one
  of several proposals from a run without losing the rest. No version churn.
- **Version-switch** (timeline): re-materialize the draft from a chosen snapshot —
  coarse, non-destructive "restore." Discards uncommitted draft changes (which are
  recoverable: they were snapshotted at the last run/checkpoint, or never run).

Because edits and reverts no longer snapshot, switching versions and reverting can
no longer produce contradictory parallel chains.

## UI

- **"Create version"** button near the rubric/version panel
  (`RubricVersionSwitcher`), with an optional note field.
- **"Unsaved changes since vN"** indicator shown when the draft's content-SHA
  differs from `active` (drives both the button's emphasis and the run's
  snapshot-if-dirty).
- **Revert** keeps its button in `RefinementHistory` / `AdherenceRefinePanel`; its
  copy no longer implies a version was created.

## Touch points

- `server/lib/refine/provenance.ts` — `applyRefinement`, `revertRefinement`: drop
  `snapshotAfterEdit`.
- `server/lib/refine/adherence-provenance.ts` — `applyAdherenceRefinement`,
  `revertAdherenceRefinement`: drop `snapshotAfterEdit`.
- `server/rubric-routes.ts` (+ `server/adherence-rubric-routes.ts`) — AUTHOR PUT:
  drop `snapshotAfterEdit`.
- **New route** `POST /api/rubric/:taskId/sessions/:sessionId/versions` — create a
  version from the current draft (body `{ note? }`), dedup-aware.
- `packages/infra-batch-run/src/runs.ts` (run start) — snapshot-if-dirty before
  recording provenance; label `run:<iterId>`.
- `packages/rubric-versions/src/index.ts` — add a `draftDiffersFromActive(root)`
  (content-SHA compare) helper used by both the indicator and snapshot-if-dirty.
- Client: `RubricVersionSwitcher.tsx` (button + indicator), `RefinementHistory.tsx`
  / `AdherenceRefinePanel.tsx` (revert copy).

## Edge cases

- **Dedup:** `snapshotVersion` already content-SHA-dedups; "Create version" and
  snapshot-if-dirty reuse the active version when the draft is unchanged.
- **Empty / no-op draft:** "Create version" with no changes is a no-op (returns the
  active version, `unchanged: true`).
- **Discard uncommitted changes:** switching to a version re-materializes the
  draft from that snapshot = discard. If the draft is **dirty**
  (`draftDiffersFromActive` is true), the switch confirmation must warn that
  uncommitted edits will be discarded. Edits that were applied but never run or
  checkpointed are then lost from the draft (the refinement-log entries remain as
  a record, but are not auto-reapplied). No separate "discard" control in v1.
- **Intervening edit on revert:** still possible (revert a field edited again in
  the draft); keep the `intervening_edit` flag + warning. The overwritten text is
  recoverable from the version snapshotted at the last run/checkpoint.
- **Promote** is unchanged (operates on the active version).

## Scope

Phenotype and adherence share the apply/revert/snapshot seam, so both are covered
by the same change. NER refinement has no apply path yet (out of scope).

## Testing

- Unit: applying/reverting/author-editing mutate the draft and do **not** create a
  version (assert `versions.json` count unchanged).
- Unit: "Create version" snapshots the draft (and dedups a no-op).
- Unit: `draftDiffersFromActive` true after an apply, false after a snapshot.
- Route/integration: run start snapshots-if-dirty and records the new version;
  a second run with no edits reuses it (no new version).
- Regression: the 2026-06-18 session-scoping tests (apply writes the fork, not the
  baseline) still pass with the snapshot removed.

## Out of scope

- NER refinement apply/versioning.
- A named "discard draft" control (switch-to-active covers it).
- Cross-run version grouping UI beyond the existing `iter_id` on log entries.
