# Phase-driven workspace — replacing Studio's tab grid

**Date:** 2026-05-06
**Status:** Proposed; awaiting sign-off
**Predecessors:**
- `2026-05-05-annotation-first-pilot-ui-design.md` (annotation flow)
- `2026-05-05-guideline-modification-impact.md` (revisit list + per-criterion provenance)

---

## Problem

The current Studio surface organizes work by **domain** — eight tabs (Guideline / Pilots / Rules / Calibration / Cohorts / Issues / Methods / Bundles). The methodologist's mental model is **workflow**: "I'm in the middle of validating; what do I do next?" That question doesn't fit a tab — it spans Pilots (validation) plus Guideline (where edits happen) plus Rules (where proposals queue) plus Issues (where problems surface).

Symptoms:
- "I don't know what to click."
- All eight tabs visible all the time, no signal which is current.
- The lifecycle stage bar (`draft → piloted → calibrated → locked`) tells the user a theoretical position, not the next action.
- Revision triggers come from validation but the editor lives elsewhere — physically separate surfaces.

The user's job is fundamentally a **linear pipeline with one revise loop**, not a domain grid. The UI should reflect that.

## Design

### The six phases

The methodologist's work decomposes into six phases. Five flow forward; phase 4 (DECIDE) branches back to phase 1 (DRAFT) to refine, or forward to phase 5 (LOCK) to finalize.

```
   ┌─────────────── revise loop ───────────────┐
   ▼                                            │
1. DRAFT  → 2. TRY  → 3. VALIDATE  →  4. DECIDE  →  5. LOCK  →  6. DEPLOY
```

| Phase | Purpose | Output | Primary surface |
|---|---|---|---|
| **1. DRAFT** | Write or edit the rubric | A versioned set of criteria | Criterion editor (existing GuidelineTab content) |
| **2. TRY** | Pick patient sample, run agent | Per-cell agent answers | Cohort picker + run launcher (existing PilotsTab/IterDetail kickoff) |
| **3. VALIDATE** | Reviewer commits truth per cell | Fully-validated `(criterion × patient)` matrix | Per-cell validation surface (existing PatientReview + RevisitList) |
| **4. DECIDE** | Choose: refine or finalize | Either next-version criteria edits, or "lock approved" | Decision screen with two CTAs |
| **5. LOCK** | Freeze rubric, run κ + lock test | Locked guideline + methods bundle | Existing Calibration + Methods/Bundles tabs, presented sequentially |
| **6. DEPLOY** | Run on production cohort | Per-patient outputs at scale | Existing CohortsTab |

The DECIDE phase exists separately because choosing to revise vs lock is itself a deliberate decision moment, not a side effect of validation completion.

### Version is the iter (unification)

Today the platform has both `task.manual_version` (a string) and `pilot iters` (`iter_001` etc., with their own `state` machine and `dev_patient_ids` cohort). They overlap heavily.

**Decision:** unify them. A "guideline version" IS a pilot iter. Naming changes:

- `iter_001`, `iter_002`, ... → `v1`, `v2`, ...
- `PilotManifest` → `GuidelineVersion` (same shape, renamed)
- The maturity ladder (`draft / piloted / calibrated / locked`) becomes a derived property of the active version

Migration of historical `iter_NNN/` directories to `vN/` happens via an audit-only rename script (see Migration section).

### Version state machine

Each version progresses through these states:

```
1. drafted
   ↓ kick off agent
2. agent_running
   ↓ all cells produced
3. awaiting_validation
   ↓ reviewer commits first cell
4. validating
   ↓ every cell has a reviewer-committed answer
5. validated
   ↓ branch
   ├─→ revising → next version born → this version becomes "superseded"
   └─→ locked   → terminal; methods bundle shippable
```

Plus terminals: `abandoned` (methodologist gave up) and `superseded` (a child version exists).

These map onto existing pilot states with minor additions:
- `running` ≅ `agent_running`
- `ready_to_validate` ≅ `awaiting_validation`
- `complete` ≅ `validated`
- `abandoned` unchanged
- New: explicit `validating` (mid-validation), `revising` (mid-edit), `superseded`, `locked`

### Patient sample carry-forward

When `vN+1` is born from `vN`:

- Default: `vN+1.patient_sample = vN.patient_sample`. No re-sampling unless explicit.
- Methodologist may add patients (extend) or remove patients (drop) before kicking off agent.
- All existing `field_assessment` records on shared patients carry forward as-is. Their `captured_against_schema_hash` determines whether they're fresh or stale relative to `vN+1`'s criteria snapshot.

This means revision doesn't *cost* validation work — it only invalidates the cells whose criterion actually changed.

### Permissive revision flow

The methodologist may revise at *any* version state, with one exception: cannot revise a `locked` version (the terminal lock is non-negotiable).

When the user clicks "Edit C" on a non-locked version V:

```
v_current → v_next is born
  · v_next.criteria = v_current.criteria + the C edit
  · v_next.patient_sample = v_current.patient_sample (modifiable)
  · all reviewer assessments inherited as-is

For each (patient, criterion) cell in v_next:
  IF cell has reviewer assessment AND captured_hash == v_next's hash for that criterion
  → FRESH (counts toward completeness)
  ELSE IF cell has reviewer assessment but hash differs
  → STALE (revisit list)
  ELSE
  → UNVALIDATED
```

A confirm dialog before save discloses the cost: "Saving this edit creates v4. 12 prior validated cells will need revisit." User can cancel or proceed.

The `validated` → `locked` transition is the one strict gate: locking requires every cell on the version to be FRESH. If any cell is STALE or UNVALIDATED, the Lock CTA is disabled.

### In-context flag (optional shortcut)

While in the VALIDATE phase, the reviewer can right-click a criterion → "Flag for revision" with an optional note. The flag is informational — it does not gate or trigger anything. When the version reaches `validated`, the DECIDE phase shows flagged criteria as "criteria you flagged" with a one-click "Edit these" path. Reviewers may also revise unflagged criteria from the same screen.

The flag and the direct-edit-anytime path are independent — the flag is for "I noticed this but want to keep validating first." Both eventually pass through the same revision mechanic.

## UI shape

### Top-level workspace replaces Studio

The route `#/studio/<taskId>/<subTab?>` continues to work for back-compat, but the rendered component changes. The new top-level component is `Workspace`:

```
┌────────────────────────────────────────────────────────────────────┐
│ HEADER (existing AppShell)                                         │
│  Home · v3 · Workspace                                             │
├────────────────────────────────────────────────────────────────────┤
│ Phase pill bar (always visible — slim, one row):                   │
│  [DRAFT ✓] [TRY ✓] [VALIDATE ●] [DECIDE] [LOCK] [DEPLOY]            │
├────────────────────────────────────────────────────────────────────┤
│ Phase headline + counts (one line):                                │
│  VALIDATE · v3 · 23 of 55 cells validated                          │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ ACTIVE PHASE SURFACE                                               │
│ (the one component that owns this phase fills the screen)         │
│                                                                    │
│ Ends with the primary CTA:                                         │
│  [ Continue validating →  ] OR [ Advance to DECIDE → ]            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Pill bar mechanics

- `✓` = phase complete for the current version
- `●` = current phase
- (no glyph) = future phase (greyed out, not clickable in default mode)
- The pill bar is a read-only progress signal in default mode. In "Show all tools" mode it becomes clickable for jumping freely.

### Phase surfaces (which existing component fills each)

| Phase | Surface |
|---|---|
| DRAFT | `GuidelineTab/index.tsx` content (criterion editor + diff against parent version) |
| TRY | New thin component: `PhaseTry` — patient-sample picker (defaults to carry-forward) + "Run agent" button. Wraps existing iter-start logic. |
| VALIDATE | `PatientReview` (annotation-first UI) + `RevisitList` (revisits). Single tabbed sub-view: "Patients" \| "Revisits." |
| DECIDE | New thin component: `PhaseDecide` — shows validation summary, lists flagged criteria, exposes two CTAs ("Revise" and "Lock"). |
| LOCK | Existing `CalibrationTab` + `MethodsTab` + `BundlesTab` content presented as a checklist of lock prerequisites. |
| DEPLOY | `CohortsTab` content unchanged. |

### "Show all tools" escape hatch

A small icon-only toggle in the top-right of the workspace flips the phase-driven view to a free-navigation mode:
- Pill bar becomes clickable; user can jump to any phase regardless of completeness.
- A secondary nav row appears underneath, listing all the legacy tabs (`Issues`, `Rules`, `Methods`, `Bundles`, etc.) for surfaces that don't have a phase home.
- The toggle's state persists per-task in localStorage.

This mode exists for power users, debugging, and "I just want to look at something" jumps. It is NOT the primary mode.

### Single primary CTA

In every phase, exactly one button is the primary action. The CTA's label depends on phase + state:

- DRAFT: "Save and continue to TRY" (after first criterion edit) or "Edit a criterion" (idle)
- TRY: "Run agent on N patients"
- VALIDATE: "Validate next cell" → "Validate next patient" → "All validated — continue to DECIDE"
- DECIDE: dual CTAs only here — "Revise" and "Lock" (sized equally, methodologist must consciously choose)
- LOCK: "Run calibration" → "Run lock test" → "Lock this version"
- DEPLOY: "Run on cohort"

When the primary CTA's prerequisites are met for advancement, its label becomes "Advance to <next phase> →" and the next pill in the bar lights up.

## Schema additions / changes

### `GuidelineVersion` (renamed from `PilotManifest`)

```typescript
interface GuidelineVersion {
  task_id: string;
  version_tag: string;          // "v1", "v2", ...
  version_num: number;
  parent_version_tag: string | null;
  run_id: string;               // batch run id
  guideline_sha: string;        // SHA of the criteria snapshot at version start
  criteria_snapshot: Record<string, string>;  // field_id → schema_hash
  patient_sample: string[];     // patient_ids included in this version
  state:
    | "drafted"
    | "agent_running"
    | "awaiting_validation"
    | "validating"
    | "validated"
    | "revising"
    | "locked"
    | "superseded"
    | "abandoned";
  flagged_criteria?: Array<{ field_id: string; note?: string; flagged_by: string; flagged_at: string }>;
  started_at: string;
  state_changed_at: string;
  notes?: string;
}
```

The existing `PilotManifest` type stays as an alias for back-compat during transition.

### Computed view: `VersionCellMatrix`

Not stored — computed by joining `GuidelineVersion.patient_sample × criteria_snapshot` against per-patient `field_assessments`. Each cell:

```typescript
type CellState = "fresh" | "stale" | "unvalidated";

interface VersionCell {
  patient_id: string;
  field_id: string;
  state: CellState;
  reviewer_answer?: unknown;
  captured_against_schema_hash?: string;
  agent_answer?: unknown;
}
```

Used by VALIDATE phase (worklist), DECIDE phase (completeness check), LOCK phase (gate).

## Server-side changes

Minimal — the data model changes are mostly renames + state additions:

- `PilotManifest` interface renamed to `GuidelineVersion` with new state values added (existing values preserved as aliases).
- Two new state transitions persisted: `validating` (when first cell is committed) and `revising` (when "Edit criterion" is clicked from a non-locked version).
- New endpoint: `POST /api/versions/:taskId/:versionTag/revise` — accepts criteria edits, creates new version, returns new version_tag.
- New endpoint: `GET /api/versions/:taskId/:versionTag/cells` — returns the computed VersionCellMatrix.
- Existing `pilots/<iter_id>/...` paths continue to work (migration script renames directories; existing routes alias to `versions/<version_tag>/...`).

## Migration

### `iter_NNN/` → `vN/` rename (audit-only)

Historical pilot iter records are renamed by a one-shot script:

- `guidelines/<task_id>/pilots/iter_001/` → `guidelines/<task_id>/versions/v1/`
- Inside each renamed directory, the manifest is rewritten with `version_tag: "v1"` (preserving all other fields).
- Old `iter_id` field stays in the manifest as `legacy_iter_id` for trace-back.
- A symlink at the old path points to the new one for back-compat with any external references.

Script lives at `chart-review-platform/scripts/migrate-iters-to-versions.ts`. Run once per environment, idempotent (skips already-migrated dirs).

### State value migration

Old states map onto new ones:
- `running` → `agent_running`
- `ready_to_validate` → `awaiting_validation`
- `complete` → `validated` (or `superseded` if a child exists)
- `abandoned` unchanged

Old manifests rewritten on first read.

## Out of scope (deferred)

- The actual sampling-suggestion algorithm — patient sample defaults to carry-forward; explicit add/remove only.
- Multi-reviewer concurrency on `revising` or `validating` (single-author assumption holds).
- Full DEPLOY phase UX — scaffolding only; the existing CohortsTab content fills it for now.
- A first-run onboarding tour.
- Power users' "Show all tools" mode is implemented minimally (a toggle that reveals legacy tabs in a secondary nav). Polish deferred.

## What this replaces / what stays

| Component | Status |
|---|---|
| `Studio.tsx` (the eight-tab grid) | **replaced** by `Workspace.tsx` |
| Existing tab components (`GuidelineTab`, `PilotsTab`, etc.) | **retained** — used as phase surfaces and via "Show all tools" |
| `PilotManifest` type + `pilots/<iter>/` directory layout | **renamed** to `GuidelineVersion` + `versions/<v>/` |
| Maturity ladder (`MaturityState` enum) | **retained** but derived from active version's state, not stored separately |
| `WorkflowStatusBanner` (current next-step hint) | **replaced** by the phase headline + pill bar |
| `RevisitList` (just shipped) | **retained** — surfaces inside VALIDATE phase |
| `CriterionCard` (annotation-first UI) | **retained** — surfaces inside VALIDATE phase |
| Existing routes (`/api/pilots/...`) | **retained** with new aliases (`/api/versions/...`) |

## Success criteria

1. From any phase, the user can see at a glance: which phase they're in, how complete it is, what the next action is.
2. The number of "click decisions" between sitting down at the screen and starting useful work drops from N (current) to 1 (the primary CTA).
3. A first-time user can complete a draft → try → validate → lock cycle without consulting documentation.
4. Power users can still reach any legacy surface via "Show all tools."
5. No data loss during migration; existing `iter_NNN` directories remain readable via the new `versions/` namespace.

## Open questions resolved

| Question | Decision |
|---|---|
| Strict gate vs permissive revision | **Permissive** — revise anytime; cost (stale cells) disclosed in confirm dialog. |
| Lock gate | **Strict** — cannot lock until every cell on the version is FRESH. |
| Version naming scheme | **Sequential** — `v1`, `v2`, `v3`. Date-based / semver too noisy. |
| Patient sample at version birth | **Carry-forward by default**, methodologist may add/remove explicitly. |
| Replace Studio or augment | **Replace** — phase-driven workspace is the only default mode; "Show all tools" is the escape hatch. |
| Iter / version unification | **Unify** — `iter_NNN` → `vN`. |
| In-context revision flag | **Optional shortcut**, not gating. |
| Sampling-suggestion algorithm | **Out of scope.** Manual + carry-forward only for v1. |
