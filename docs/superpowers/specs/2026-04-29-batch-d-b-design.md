# Design Spec — Batch D-B (Protocol version graph + migration UI)

**Date**: 2026-04-29
**Status**: Approved for implementation planning
**Owner**: Xing He
**Related**:
- `docs/methodology/perfect-system-storyline.md` Beat 12 — branch + impact simulator + targeted re-run + `superseded_by` archival (currently ☐ → this batch closes it)
- `docs/methodology/rethink-chart-review.md` Shift 4 — protocol-as-code with first-class version graph
- `docs/superpowers/specs/2026-04-29-tier-a-followups-design.md` — Lock workflow shipped `lock_task_sha` per record; this batch builds the version graph on top

---

## 1 — Goal

Ship the protocol version graph + migration UI so a lead reviewer can:

1. **See version history** — a list of every locked task SHA with diff between any two versions.
2. **Run an impact simulator** when the live task changes — predict which locked records would change answers under the new version, based on a structural heuristic.
3. **Targeted re-run** — re-review only the records the heuristic flags as affected, leaving unaffected records pinned to their existing locked SHA.
4. **`superseded_by` archival** — when a record is re-reviewed under a new version, the old locked record is preserved with a `superseded_by` pointer to the new record.

This closes Beat 12 (☐ → ✓).

**Effort**: ~7-10 days. Version archive (~1d) + revision-history view (~2d) + impact simulator (~3d) + targeted re-run (~2d) + integration glue + smoke + STATE (~1d).

**Beats moved**: Beat 12 ☐ → ✓.

**Out of scope** (future cycles): full agent replay impact simulator (heuristic v1 only); cross-task version comparison; automated version-bump on every task save.

## 2 — Architecture

**One spec, one plan.** New: lock-time hook that snapshots the compiled task JSON; new server modules for diff + impact-simulator + migration; new client surface in MethodologistView (revision history) + Studio (migration controls).

**New server modules**:
- `app/server/version-archive.ts` — write/read snapshots at `tasks/<task_id>/versions/<lock_task_sha>.json`
- `app/server/task-diff.ts` — semantic diff between two compiled task snapshots (per-field changes, including `is_applicable_when` / `derivation` text)
- `app/server/impact-simulator.ts` — heuristic algorithm: identifies records where the diff intersects fields the record has answered
- `app/server/migration.ts` — orchestrates targeted re-run via existing batch runner

**Modified server files**:
- `app/server/routes-reviewer.ts` — extend `POST /lock` to also snapshot to versions/ directory
- `app/server/audit-trail.ts` — 2 new step types: `record_superseded`, `migration_run`
- `app/server/review-state.ts` — `superseded_by?: string` already in schema; ensure it propagates correctly
- `app/server/server.ts` — mount new migration routes

**New client surfaces**:
- `RevisionHistoryView.tsx` — list of versions per task + diff viewer
- `ImpactSimulatorPanel.tsx` — Studio extension: select from-sha + to-sha, run simulator, show affected-record list
- `MigrationPanel.tsx` — companion to ImpactSimulator, kicks off targeted re-run

**Schema additions**:
- `review_state.schema.json`: `superseded_by?: string` (already exists per original schema; verify and document)
- New file shape: `tasks/<task_id>/versions/<lock_task_sha>.json` (compiled task snapshot)

**No new dependencies.**

## 3 — Version archive

### 3.1 Snapshot at lock time

The existing `POST /api/reviews/:pid/:tid/lock` endpoint computes `lock_task_sha = sha256(tasks/compiled/<tid>.json).slice(0,16)` and persists it on the record. Extend the endpoint to ALSO write a copy of the compiled task JSON to `tasks/<task_id>/versions/<lock_task_sha>.json` if it doesn't already exist (idempotent — multiple records sharing the same SHA write the same content once).

### 3.2 Archive structure

```
tasks/
  compiled/
    <task_id>.json           ← live compiled task
  <task_id>/
    versions/
      <sha1>.json            ← snapshot at lock-time
      <sha2>.json            ← later snapshot (different lock)
      ...
```

The directory at `tasks/<task_id>/` already exists for some tasks; expand to include `versions/` subdir.

### 3.3 `version-archive.ts` API

```ts
export interface VersionEntry {
  task_id: string;
  lock_task_sha: string;
  archived_at: string;       // first time this SHA was archived
  record_count: number;       // how many locked records reference this SHA (computed from disk)
  task_version?: string;      // human-readable from compiled task (optional)
}

/** Write snapshot of compiled task to versions/<sha>.json (idempotent). */
export function archiveVersion(taskId: string, lockTaskSha: string): void;

/** List all archived versions for a task, sorted by archived_at desc. */
export function listVersions(taskId: string, reviewsRoot: string): VersionEntry[];

/** Read a specific version's compiled task JSON. */
export function loadVersionedTask(taskId: string, lockTaskSha: string): unknown;
```

### 3.4 Endpoint

`GET /api/versions/:task_id` → returns `VersionEntry[]`. Reviewer auth required.

### 3.5 Tests

`app/server/__tests__/version-archive.test.ts`:
- `archiveVersion` writes to versions/ + idempotent
- `listVersions` returns entries sorted desc with correct record_count
- `loadVersionedTask` returns the JSON

## 4 — Task diff

### 4.1 Semantic diff algorithm

`app/server/task-diff.ts` exports:

```ts
export interface FieldDiff {
  field_id: string;
  status: "added" | "removed" | "changed" | "unchanged";
  changes?: Array<{
    key: string;            // e.g., "is_applicable_when", "derivation", "answer_schema", "guidance_prose"
    from: unknown;
    to: unknown;
  }>;
}

export interface TaskDiff {
  from_sha: string;
  to_sha: string;
  fields: FieldDiff[];
  global_changes: Array<{ key: string; from: unknown; to: unknown }>;  // task-level (e.g., source_document_sha, stratify_by)
}

export function computeTaskDiff(fromTask: unknown, toTask: unknown): TaskDiff;
```

For each field in either task: classify as added/removed/changed/unchanged. For `changed`, list the specific keys that differ. The simulator uses the `is_applicable_when` and `derivation` change keys specifically.

### 4.2 Endpoint

`GET /api/diff/:task_id?from=<sha>&to=<sha>` → returns `TaskDiff`. Reviewer auth required.

### 4.3 Client

`RevisionHistoryView.tsx` renders the diff side-by-side:
- Left column: from-version field render
- Right column: to-version field render with changes highlighted (green = added, red = removed, yellow = changed)
- Top: version selector (two dropdowns populated from `/api/versions/:tid`)

### 4.4 Tests

`app/server/__tests__/task-diff.test.ts`:
- 2 tasks identical → all unchanged
- Add a field → status: "added"
- Remove a field → status: "removed"
- Change `is_applicable_when` → status: "changed", changes lists `is_applicable_when`

## 5 — Impact simulator (heuristic)

### 5.1 Algorithm

For a hypothesized migration from `from_sha` to `to_sha`:

1. Compute `TaskDiff(from_sha, to_sha)`.
2. Extract the set of "structurally changed" field IDs — those with `status: "changed"` whose `changes[]` includes at least one of: `is_applicable_when`, `derivation`, `answer_schema`, `guidance_prose` (the keys that affect agent behavior). Plus all `added` and `removed` fields.
3. For each locked record under `from_sha` (i.e., review_state.lock_task_sha == from_sha):
   - If any of its `field_assessments[].field_id` is in the structurally-changed set, the record is **affected**.
   - Otherwise, the record is **unaffected** (its answers don't intersect the diff).
4. Return `{ affected: PatientId[], unaffected: PatientId[], total: number }`.

This is a lightweight heuristic — it doesn't actually re-run the agent. Real-world result: if the diff only touches `guidance_prose` (description), the heuristic flags every record as affected; if the diff only touches one new field added, the heuristic flags zero records (no existing record has the new field).

A future "full replay" simulator would actually run the agent against each affected record and compare answers. Out of scope for v1.

### 5.2 `impact-simulator.ts` API

```ts
export interface ImpactInput {
  taskId: string;
  fromSha: string;
  toSha: string;
  reviewsRoot: string;
}

export interface ImpactResult {
  total_locked: number;
  total_unlocked: number;
  affected: Array<{ patient_id: string; review_status: string; intersect_fields: string[] }>;
  unaffected: string[];
  changed_field_ids: string[];   // the structurally-changed set
}

export function simulateImpact(input: ImpactInput): ImpactResult;
```

### 5.3 Endpoint

`POST /api/migration/:task_id/simulate` body `{ from_sha: string, to_sha: string }` → returns `ImpactResult`. Reviewer auth required.

### 5.4 Tests

`app/server/__tests__/impact-simulator.test.ts`:
- 3 locked records: 2 with `field_assessments` for "x", 1 for "y". Diff changes "x"'s `is_applicable_when`. Expect `affected = [the 2 records with x]`, `unaffected = [the y-only record]`.
- Diff only touches `guidance_prose` for "x" → still affects the 2 records (per heuristic; we treat guidance_prose changes as structural).
- Diff adds a new field "z" not in any record → no records affected.

## 6 — Targeted re-run

### 6.1 Endpoint

`POST /api/migration/:task_id/run` body:
```ts
{
  from_sha: string;
  to_sha: string;
  patient_ids?: string[];   // explicit list overrides simulator
  dry_run?: boolean;        // simulate only, no actual re-runs
}
```

Server:
1. Compute `simulateImpact(from_sha, to_sha)` if `patient_ids` not provided.
2. For each affected record, set `review_status` back to `agent_complete` (re-opens for review). Mark old record `superseded_by: <new patient×task triplet, e.g., null for now since same patient×task>`. Wait — `superseded_by` is for cross-version pointing. For v1, just unlock the affected records and leave a note in audit log.
3. Emit `migration_run` audit entry per record listing `from_sha → to_sha` and the diff context.

### 6.2 `superseded_by` semantics for v1

For this batch, `superseded_by` ARCHIVES the old record's state under `reviews/<pid>/<tid>/_archive/<from_sha>.json` (read-only) and reopens the live record. The archive file stores the locked v1 record in full. The live record points to it via `superseded_by: "_archive/<from_sha>.json"`.

This preserves the audit chain (the locked v1 record exists on disk, immutable) while allowing v2 review to proceed.

If the user wants to view the archived v1 record (e.g., from MethodologistView), they fetch `_archive/<from_sha>.json` directly.

### 6.3 Audit step types

```ts
| (BaseEntry & {
    step_type: "record_superseded";
    from_sha: string;
    to_sha: string;
    archived_path: string;      // _archive/<from_sha>.json
    triggered_by: string;       // "migration:<from_sha>->...:<to_sha>"
  })
| (BaseEntry & {
    step_type: "migration_run";
    from_sha: string;
    to_sha: string;
    affected_count: number;
    triggered_by: string;       // reviewer_id
  })
```

### 6.4 `migration.ts` API

```ts
export interface MigrationInput {
  taskId: string;
  fromSha: string;
  toSha: string;
  patientIds: string[];
  reviewsRoot: string;
  triggeredBy: string;
}

/** For each patient: archive current locked state, unlock the record, emit audit. */
export async function runMigration(input: MigrationInput): Promise<{
  archived: string[];
  reopened: string[];
  errors: Array<{ patient_id: string; error: string }>;
}>;
```

### 6.5 Tests

`app/server/__tests__/migration.test.ts`:
- 2 locked records → migrate → archive files exist + records are `agent_complete` again + 2 audit entries each
- Already-archived record → idempotent (doesn't re-archive)
- Records with non-matching from_sha → skipped with error

## 7 — Client UI

### 7.1 RevisionHistoryView

Path-based dispatch in App.tsx already exists for `/methodologist/...`. Add a similar one for `/revisions/<tid>` (no auth — public view), OR more conservatively, make it an in-app component reachable from MethodologistView.

**Decision**: in-app, behind viewer-token auth (matches MethodologistView's privacy model).

`MethodologistView.tsx` — add a new section "Revision history" that lists versions and renders the diff viewer when 2 versions are selected.

```tsx
// In MethodologistView's TaskView component:
<section>
  <h2>Revision history</h2>
  <RevisionHistoryView taskId={taskId} token={token} />
</section>
```

`RevisionHistoryView.tsx` itself:

```tsx
import { useState, useEffect } from "react";
import type { TaskDiff, VersionEntry } from "./types";

export function RevisionHistoryView({ taskId, token }: { taskId: string; token: string }) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [fromSha, setFromSha] = useState<string | null>(null);
  const [toSha, setToSha] = useState<string | null>(null);
  const [diff, setDiff] = useState<TaskDiff | null>(null);

  useEffect(() => {
    fetch(`/api/versions/${taskId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((entries: VersionEntry[]) => {
        setVersions(entries);
        if (entries.length >= 2) {
          setFromSha(entries[1].lock_task_sha);   // older
          setToSha(entries[0].lock_task_sha);     // newer
        }
      });
  }, [taskId, token]);

  useEffect(() => {
    if (!fromSha || !toSha) return;
    fetch(`/api/diff/${taskId}?from=${fromSha}&to=${toSha}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then(setDiff);
  }, [taskId, fromSha, toSha, token]);

  // Render: 2 dropdowns + per-field diff list
}
```

### 7.2 ImpactSimulatorPanel + MigrationPanel in Studio

A new tab in Studio (5th panel; grid becomes `grid-cols-5` — or stack):

`ImpactSimulatorPanel.tsx`:
- Select from-sha + to-sha (populated from `/api/versions/:tid`)
- "Simulate" button → POST `/api/migration/:tid/simulate` → display `affected[].length` count, `unaffected[].length`, list of changed_field_ids
- "Run migration" button (after simulate) → POST `/api/migration/:tid/run` with the affected list → show success summary

For v1 keep these as one panel: `MigrationPanel.tsx`. Skip a separate ImpactSimulatorPanel.

### 7.3 No additional UI for `superseded_by`

The `_archive/<from_sha>.json` file is methodologist-accessible directly via the audit log if needed. No dedicated "view archived version" button in v1 — keeps scope contained.

## 8 — Integration glue

### 8.1 Audit step types added (Section 6.3)

`record_superseded`, `migration_run`. Total Tier A → Batch D-B audit step types: 5 (Tier A) + 2 (Batch C) + 2 (Batch D-A) + 2 (Batch D-B) = 11 new beyond Phase B.

### 8.2 STATE.md update

Final task: add a "Batch D-B complete" section listing version archive + diff + impact simulator + targeted re-run + Beat 12 ✓.

### 8.3 Migration

All schema additions are additive. Existing review_state.json files validate unchanged. The `tasks/<task_id>/versions/` directory is created lazily.

## 9 — Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Heuristic impact simulator over-flags or under-flags affected records | high | medium | v1 documented as heuristic; full replay is a follow-up. UI shows the heuristic's reasoning (changed_field_ids) so reviewer can override |
| `_archive/<sha>.json` file proliferates as migrations happen | medium | low | One archive per (record × from_sha); idempotent |
| Concurrent migrations on the same record race | low | medium | applyUiAction's optimistic concurrency catches it; the second migration call returns a 409 conflict |
| Diff between very different versions (e.g., v1.0 → v3.0 skipping v2.0) returns confusing output | low | low | Diff is computed pairwise; multi-hop comparison out of scope |
| Migration creates unlocked records that aren't in any reviewer's queue → orphaned | medium | medium | Document: after migration, lead reviewer must re-assign records via existing AssignmentPanel. v2 could auto-reassign to original reviewers |

## 10 — Definition of done

- All ~14 plan tasks complete (finalized in plan doc)
- vitest ~95+ (88 + ~10 new)
- pytest 107 (no new tests)
- Build clean
- `smoke-merged.py` extended: simulate + targeted re-run flow
- STATE.md updated with Batch D-B section + Beat 12 ✓

## 11 — One sentence

Ship the protocol version graph + migration UI so locked records under v1.0 can be diffed against v1.1, the heuristic impact simulator predicts which records are affected, and a targeted re-run reopens only those records — closing Beat 12 (currently ☐) to ✓.
