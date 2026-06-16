# Session-scoped rubric versioning

**Date:** 2026-06-15
**Status:** Design (approved for planning)
**Author:** yuhang (with Claude)

## Problem

The rubric a session runs against is **global and shared**: every session on a
task reads the same `.claude/skills/chart-review-<task>/references/criteria/*.md`.
A session only records a *content-SHA snapshot* of it — not a copy. Consequences:

1. **No isolation.** Editing a criterion or applying a refinement changes the
   rubric **every** session's next iter reads — not just the current one. The
   workspace even tells the user "Edits made here affect THIS session's next
   iter — that's the inner loop," which is currently a white lie.
2. **No real version history.** The server-read rubric lives under `.claude/`,
   which is git-ignored, so there is no durable, diff-able history of the rubric
   the platform actually runs. The git-*tracked* copy (`.agents/skills/`) is a
   separate, drifted directory the server never reads.
3. **Provenance is thin.** A session has multiple iters (runs), and the
   refinement loop edits the rubric *between* iters — but you can't reproduce or
   inspect the exact rubric an earlier iter used after you've edited for the
   next one.

## Goal

Each session **owns a real, versioned rubric copy** it can edit, refine, and
**switch between versions** in isolation — and an explicit, reviewed **promote**
flows a chosen version back to the shared baseline. Provenance is exact: every
iter is permanently tied to the rubric version it ran. This makes the existing
"inner loop" promise literally true and gives the rubric durable, steerable
version history at two levels.

Non-goals (v1): automatic 3-way merge on promote; retrofitting per-session
rubrics onto pre-existing sessions; cross-task rubric sharing.

## Approach (chosen)

**Per-session rubric directories + an app-managed version index**, mirroring the
existing per-session *reviews* model (`var/reviews/<sid>/`). Versioning is
explicit filesystem snapshots + a log — self-contained, independent of git
semantics, and concurrent-session-safe. (Rejected: git-branch-per-session — a
single working tree can't hold two sessions' rubrics at once, and the agent
reads files from disk so you'd materialize per-session dirs anyway. Rejected:
overlay/diff — the agent reads whole files, so a merged view must be
materialized regardless, erasing the storage win.)

## Architecture

### Storage layout

```
.claude/skills/chart-review-<task>/
├── references/criteria/*.md              BASELINE — current canonical rubric   [git-TRACKED]
├── versions/
│   ├── versions.json                     baseline version log (vN, sha, by, when, source) [TRACKED]
│   └── v4/references/criteria/*.md        immutable snapshot of each promoted baseline      [TRACKED]
├── sessions/<session_id>/
│   ├── rubric/
│   │   ├── references/criteria/*.md       working copy = the session's ACTIVE version       [git-ignored]
│   │   └── versions/
│   │       ├── versions.json              session version log (sN, sha, parent, source, when) [git-ignored]
│   │       └── s2/references/criteria/*.md immutable snapshot per rubric change               [git-ignored]
│   └── <session manifest>                (exists today; gains active_version + based_on)
└── pilots/<iter_id>/                     (exists today; iter manifest gains rubric_version)   [git-ignored]
```

- **Canonical tree = `.claude/skills`** (what the server already reads). Un-ignore
  exactly `references/` + `versions/` so the baseline and promoted baseline
  versions are git-tracked (durable, diff-able history). Keep `sessions/` and
  `pilots/` git-ignored — they are per-session working state, reproducible from
  the iter's pinned SHA, exactly like `var/reviews/<sid>/`.
- **Retire the `.agents/skills` rubric duplicate** (drifted, unread). Its only
  live use is the PLATFORM_ROOT marker (`packages/patients`); repoint that marker
  to `.claude/skills` and delete the stale rubric copy. One source of truth.

### Recursive version model

Versioning is the **same mechanism applied at two levels** (one shared
version-index module, rooted at two different dirs):

- **Outer loop — baseline versions `v1…vN`** (across sessions). Promote appends a
  new baseline version.
- **Inner loop — session versions `s1…sM`** (across a session's iters). Every
  rubric change in the session appends a new session version.

Versions are **immutable + append-only**; an **`active_version` pointer** (on the
session manifest, and a baseline pointer at the task level) is movable. The
working copy `references/` always mirrors the active version (materialized so the
agent reads plain files).

### The resolver seam

A single new choke point — no caller hand-builds rubric paths:

```
resolveRubricDir(taskId, sessionId?) ->
  sessions/<sid>/rubric/references/   if that fork exists
  else references/                    (baseline; the lazy-migration fallback for legacy sessions)
```

All rubric reads (the batch run, the criteria/faithfulness reads) and writes (the
AUTHOR RubricPanel save, refinement `Apply`, adherence-rubric edits) route through
it. This is the behavior change that makes edits/refinements land in **only the
current session's** fork.

## Lifecycle / data flow

1. **Create → fork.** `createSession` copies the current baseline `references/`
   into `sessions/<sid>/rubric/` as session version `s1`, sets `active_version=s1`
   and `based_on=v<N>` on the manifest.
2. **Run → reads the active version.** The batch run knows its session
   (iter → `session_id`); `runOneAgent` resolves criteria via
   `resolveRubricDir(task, sid)`, **captured once at run start**. The iter
   manifest records `rubric_version: s2` (provenance). A run already in flight
   keeps its pinned version even if the user switches mid-run.
3. **Edit / refine → appends a session version.** An AUTHOR save or a refinement
   `Apply` writes the working copy, then snapshots a new immutable session version
   `s(M+1)` (recording `parent` = the version active when the edit started,
   `source` = `refine:<field>` | `author-edit`), and moves `active_version` to it.
   Byte-identical content (content-SHA match) does not create a duplicate.
4. **Switch → move the active pointer.** Pick any `sK` from the timeline →
   `active_version = sK`, re-materialize `references/` from `sK`. Non-destructive
   (`sK` untouched; switch back any time). Editing after a switch appends a new
   version with `parent: sK`, so history can branch while the snapshot list stays
   a clean append-only set.
5. **Promote → new baseline version.** A new `POST /api/rubric/<task>/promote`
   (body: `{ session_id, session_version }`, default = active) diffs the chosen
   session version vs the current baseline, the user confirms, and it copies that
   content → baseline, appends an immutable `versions/vN+1/` snapshot + a
   `versions.json` entry (diff, who, when, source session), and moves the baseline
   pointer. Other live sessions' forks are untouched. Future sessions fork the new
   baseline.

## Components

| Unit | Responsibility |
|---|---|
| **version-index module** (`packages/rubric` or a new `rubric-versions`) | snapshot, append-only log, active-pointer move, switch, parent tracking, content-SHA dedup, diff. Rooted at any dir → reused for baseline + session. |
| **`resolveRubricDir(task, sid?)`** | the read/write resolver seam (`packages/rubric`). |
| **`createSession` fork step** (`domain-iter`) | copy baseline → `s1`, stamp `active_version` + `based_on`. |
| **run-loop change** (`infra-batch-run`) | resolve criteria via the session's active version; record `rubric_version` on the iter. |
| **edit routes** (`rubric-routes`, refine `apply`, `adherence-rubric-routes`) | write through the resolver → snapshot a session version. |
| **switch route + UI** | `POST …/sessions/<sid>/rubric/switch {version}`; the version-switcher component. |
| **promote route + UI** | `POST /api/rubric/<task>/promote`; reviewed-diff confirm. |

## UI — version switcher

In the session panel (near ITERS / "Open skill rubric"): a **rubric-version
timeline** — `s1 · forked from v4`, `s2 · refine: cancer_type`, `s3 · manual
edit` — active one marked, each annotated with which iters ran on it. Click a
version → **Switch** (confirm + diff vs current). A small **diff view**
(version A ↔ B). The **same component** drives baseline versions (`v1…vN`) at the
task level (switch which baseline is canonical / a new session forks from). Add
the corresponding invariants to the `chart-review-ui-smoke` e2e suite.

## Migration / backward-compat

- **Seed baseline `v1`** from the current rubric content. The live rubric is
  presently in a demo-gapped state (an injected gap + an applied refinement rule
  from the validation test) — **restore it to pristine first**, then seed `v1`
  from the clean baseline.
- Un-ignore `references/` + `versions/`; retire the `.agents/skills` duplicate;
  repoint the PLATFORM_ROOT marker.
- **Existing sessions** with no fork resolve to the baseline (today's behavior) —
  no retrofit; they simply don't gain isolation retroactively.
- The refinement provenance log becomes session-scoped going forward; existing
  global entries remain as legacy.

## Edge cases

- **Baseline drifted since fork** (another session promoted `v5` while you're on a
  fork of `v4`): on promote, detect the drift and **warn** ("baseline advanced
  v4→v5; promoting creates v6 from your content and may drop their changes"),
  require explicit confirm. No auto-merge in v1.
- **Switch mid-run:** in-flight iter keeps its pinned version; only the next iter
  sees the switch. Run reads are resolved once at run start.
- **Snapshot dedup:** content-SHA-keyed; identical content doesn't append a
  duplicate version.
- **Missing/corrupt fork:** fall back to baseline + warn (don't crash); the iter's
  pinned SHA surfaces the mismatch.
- **Concurrent edits in one session** (two tabs): each save snapshots; the
  append-only log loses nothing.
- **AUTHOR edit with no active session** (AUTHOR is session-exempt): resolves to
  the baseline, so it writes **and snapshots the baseline directly** (a new `vN+1`,
  `source: author-edit`). This is the one sanctioned baseline edit outside
  `promote` — the methodologist deliberately editing the canonical rubric. With an
  active session selected, the same editor writes the session fork instead.

## Testing

- **Unit:** `resolveRubricDir` (fork present / absent / legacy); the version-index
  module (snapshot, append-only, active-pointer move, switch, parent tracking,
  dedup, diff) — one suite covers baseline + session since it's the same module;
  `promote` (creates `vN+1`, drift warning).
- **Integration (core invariant), against the real backend (not mocks):**
  edit/refine in session A leaves session B *and* the baseline unchanged; an iter
  reads its session's active version; switching changes what the next iter reads;
  promote advances the baseline without touching other forks.
- **e2e UI smoke** (`chart-review-ui-smoke`): version timeline renders, Switch
  changes active + shows the diff, Promote flows through the confirm.
- **Backward-compat:** legacy sessions (no fork) still run against the baseline.

## Open questions (resolve in planning)

- Exact home for the version-index module: extend `packages/rubric`, or a new
  `packages/rubric-versions`. Leaning: a small new module so the two-level reuse
  is explicit and `rubric` stays focused on bundle loading.
- Whether `references/` (working copy) should be a real materialized copy or a
  symlink to the active snapshot. Leaning: real copy — edits write here then
  snapshot, and symlinks complicate the data-relocation convention.
