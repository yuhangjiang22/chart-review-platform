# Refinement Workspace Redesign — Design

**Date:** 2026-06-19
**Status:** approved (design), pending implementation plan
**Builds on:** `2026-06-18-working-draft-rubric-versioning-design.md` (the working-draft
model this UI surfaces)

## Goal

Redesign the refinement UI so the **working-draft model is obvious and trustworthy**.
Today the experience is spread across three disconnected surfaces — the proposal card
(in the DECIDE table), the refinement history, and the version switcher (sidebar) — none
of which reflect the new logic (edits accumulate in a draft; versions are explicit
checkpoints). The redesign unifies them into one **git-like workspace**: make changes on
the left, watch them stack into a **working draft** on the right shown as **diffs** (what
each change removed/added), and **Save as version** when ready.

## Design decisions (settled in brainstorming)

1. **Explicit / git-like model.** The draft and the version timeline are *always visible*
   — "Working draft — N unsaved changes since sX" with a prominent **Save as version**
   action. Maximum control + provenance (the reviewer is a methodologist who cites SHAs).
2. **Two-pane layout.** Left = *make changes* (criteria + proposals). Right = *the working
   draft* (diff changelist + Save) + *version history*.
3. **Draft changes are shown as diffs.** Each change in the draft renders a git-style diff
   (removed lines red/struck, added lines green) with `+N −M` counts, **vs the last saved
   version**. Version history offers compare-to-baseline / version-to-version diffs.
4. **The workspace is its own "Refine" tab** (revised after a live review — it was first
   embedded in AUTHOR and got cramped next to the session sidebar, cutting off diff lines).
   AUTHOR is the focused rubric editor; a new **Refine** phase, placed **last**
   (`AUTHOR · TRY · JUDGE · VALIDATE · PERFORMANCE · Refine`), hosts the full-width
   workspace — you refine after seeing performance. "refine" is registered server-side
   (`workflow-phases` + `phases-routes`, `required:true` so it's always an available tab);
   the client adds a non-optional REFINE phase to `phases.ts`. Diffs render full-width and
   are git-hunked (changed lines + 2 context, longer unchanged runs collapsed to
   "⋯ N unchanged lines"). The always-on session rail (cohort/agents/iters/tools)
   is hidden on REFINE so the workspace gets the full page width, and the layout
   is diff-dominant: the working-draft diff is the wide column, with proposals +
   version history as a slim side column.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ ● Working draft — 3 unsaved changes since s2   [Save as version]│  ← draft status bar
├───────────────────────────────┬──────────────────────────────┤
│ REFINE — criteria             │ WORKING DRAFT · diff vs s2     │
│  item_1   in draft ✓          │  ✎ item_1 — refined   +3 −0 ↶ │
│  item_2   you≠agent·2 [Propose]│    ┌ extraction guidance ──┐  │
│  item_5   you≠agent·3 [Propose]│    │  …context…            │  │
│     └ gap → rule → held-out    │    │ + added rule lines    │  │
│        [Apply to draft][Edit]  │    └───────────────────────┘  │
│        [Dismiss]               │  ✎ item_4 — edited    +2 −1 ↶ │
│  item_6   agreed               │  ✎ item_3 — refined   +2 −0 ↶ │
│                                │  [ Save as version ]          │
│                                │  VERSION HISTORY              │
│                                │  s2 ● clarified staging       │
│                                │  s1   initial fork  [diff][↔] │
└───────────────────────────────┴──────────────────────────────┘
```

## Components

### 1. `DraftStatusBar`
Persistent header for the refine view. Reads the session version list (which already
returns `dirty` + `active`). Shows:
- `dirty=false` → "On version sX · no unsaved changes" (Save disabled).
- `dirty=true` → "● Working draft — N unsaved changes since sX" + **Save as version**
  (calls the existing `POST .../versions`, prompts for an optional note).

"N changes" = the count of changed criteria/questions in the draft-vs-active diff.

### 2. Left pane — `RefineCriteriaList`
This is the **existing DECIDE table restyled**, not new logic — it reuses the current
per-criterion disagreement clusters and the inline `RefineProposalCard` data (candidates,
gap, rule, held-out). One row per criterion (phenotype) / question (adherence), each with a
status pill:
- **in draft ✓** — has uncommitted changes (links to its diff on the right).
- **you ≠ agent · K** — K validated disagreements → **Propose fix** expands the proposal.
- **agreed / no change** — clean.

Expanding **Propose fix** renders the existing proposal flow (②gap → ③rule → ④held-out),
restyled. Actions become: **Apply to draft** (was "Apply"), **Edit**, **Dismiss** (was
"Reject" — it dismisses an *unapplied* proposal). On apply, the row flips to "in draft ✓"
and the change appears in the right pane. The cramped "Applied / Reject / Appended…" row
and the translucent-bg bleed bug (`RefineProposalCard.tsx:283`, `bg-paper/40`) are gone —
the card sits on an **opaque** surface and collapses to the status pill after applying.

### 3. Right pane — `WorkingDraftPanel`
The heart of the redesign. Lists every change in the draft (vs the active version):
- Header: "Working draft · diff vs sX · N changes".
- Per change: `✎ <field> — <refined|edited>`, `+N −M` stat, **undo**, and an expandable
  **diff** (removed lines red+strikethrough, added lines green, context muted). Refinements
  are typically pure additions; hand-edits show replacements.
- **undo** = discard that field's uncommitted changes (restore the field from the active
  version's snapshot). File-level, git-like — *not* the old per-apply log revert. The
  refinement log still records individual applies for provenance, but the draft-level undo
  is "discard this field's uncommitted edits."
- **Save as version** button (+ a one-liner: "…or hit Try on patients — it saves a version
  automatically.").

### 4. `VersionHistory` (folds in `RubricVersionSwitcher`)
Moves from the sidebar into the right pane, under the draft. Lists versions newest-first
with the active marker; per non-active version: **diff** (compare to active or step-wise)
and **switch**; **Promote to baseline** stays. The dirty-switch warning (discarding
uncommitted edits) stays.

## Data / backend

Most of the plumbing exists from the working-draft feature:
- `draftDiffersFromActive(root)` + the `dirty` flag on `GET .../versions` — drives the bar.
- `POST .../versions` (create-version) — the Save action.
- `diffVersions(root, idA, idB)` — version-to-version diffs (used by VersionHistory).

New, small additions:
- **`diffDraftAgainstActive(root)`** — diff the working copy (`references/`) against the
  active version's snapshot, returning per-file `{ field_id, added, removed, hunks }`. A
  near-clone of `diffVersions` with one side = the live working copy. Powers the changelist
  + per-change diffs + the "N changes" count.
- **`discardDraftField(root, fieldId)`** — restore one criterion/question file from the
  active version's snapshot (the changelist **undo**). A per-file checkout.
- Routes: `GET .../draft-diff` (the changelist) and `POST .../draft/discard` (undo one
  field). Both session-scoped, mirroring the existing version routes.

## Adherence parity
The same workspace serves adherence tasks — "criteria" become "questions," diffs run over
`retrieval_hints` / `text` in the question bundles. The diff/undo helpers operate on
`references/` generically, so they cover both kinds.

## What's removed / changed vs today
- **`RefineProposalCard`** — relabel Apply → "Apply to draft", Reject → "Dismiss"; drop the
  post-apply "Applied/Reject/Appended" row; opaque background (fixes the bleed-through bug);
  collapse to a status pill after applying.
- **`RefinementHistory`** — replaced by `WorkingDraftPanel`'s diff changelist. The
  "reverted but edited since" intervening-edit messaging disappears (file-level undo can't
  half-revert).
- **`RubricVersionSwitcher`** — folded into `VersionHistory` inside the right pane (no
  longer a separate sidebar island).

## Out of scope
- The session/iter `rubric` origin pin staleness (pre-existing, separate).
- NER refinement (still analyze+propose only).
- Changing the underlying working-draft mechanics (already shipped) — this is presentation
  + two small read/undo helpers.

## Testing
- Unit: `diffDraftAgainstActive` (additions, deletions, replacements, multi-file count);
  `discardDraftField` (restores one field, leaves siblings dirty).
- Route: `GET .../draft-diff` shape; `POST .../draft/discard` restores + updates `dirty`.
- Component: DraftStatusBar (clean vs dirty), WorkingDraftPanel (renders diffs + undo),
  proposal card (Apply-to-draft flips state; opaque bg).
- e2e (live): apply a refinement → it appears in the draft diff (green additions) →
  undo restores → Save as version clears the draft. Both task kinds.
