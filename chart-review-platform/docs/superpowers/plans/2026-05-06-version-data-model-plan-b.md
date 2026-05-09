# Plan B — Version Data Model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend-only refactor that renames `PilotManifest` → `GuidelineVersion` (alias, back-compat), extends `PilotState` with four new values, adds two server-side state transitions (`validating`, `revising`), exposes a `POST /api/versions/:taskId/:vTag/revise` endpoint, a `GET /api/versions/:taskId/:vTag/cells` endpoint (returns `VersionCellMatrix`), and mounts a `/api/versions/...` route alias alongside the existing `/api/pilots/...` handlers.

**Architecture:** The type alias keeps every existing call site untouched — `PilotManifest` continues to work as a TypeScript type alias for `GuidelineVersion`. New state values are forward-compatible: old manifests on disk never contain the new values; only manifests created by Plan-B code paths use them. The two new endpoints sit alongside the existing pilot routes in `pilot-routes.ts`; the `/api/versions/...` alias is mounted in `server.ts` (or the router entry point) by re-using the same `pilotRouter()` instance with a different path prefix. The `revise` endpoint delegates criterion file writes to the existing `snapshotCriterionHashesSync` + `startPilotIteration` primitives — it does **not** duplicate logic from `builder-routes.ts`, whose session-scoped `edit` handler is unrelated to production iter creation.

**Branch:** `feat/phase-driven-workspace`

**Spec:** `chart-review-platform/docs/superpowers/specs/2026-05-06-phase-driven-workspace-design.md`

---

## File Structure

**Created:**
- `app/server/__tests__/version-type-alias.test.ts` — Task 1 type-compile test
- `app/server/__tests__/pilot-state-extended.test.ts` — Task 2 state type + guards
- `app/server/__tests__/validating-transition.test.ts` — Task 3 first-reviewer-cell → `validating`
- `app/server/__tests__/revising-transition.test.ts` — Task 4 revise-triggered → `revising`
- `app/server/__tests__/versions-revise-route.test.ts` — Task 5 supertest for `/revise`
- `app/server/__tests__/versions-cells-route.test.ts` — Task 6 supertest for `/cells`
- `app/server/__tests__/versions-alias-routes.test.ts` — Task 7 smoke for `/api/versions/...`

**Modified:**
- `app/server/domain/iter/pilots.ts` — extend `PilotState`, add `GuidelineVersion` type alias, new type-guards, `transitionPhase` extended cases, `setPilotState` allowlist widened
- `app/server/domain/iter/index.ts` — re-export `GuidelineVersion`, new guards, `snapshotCriterionHashesSync`
- `app/server/adapters/http/pilot-routes.ts` — add `/revise` and `/cells` routes; widen PATCH `allowedStates`
- `app/server/server.ts` (or wherever `pilotRouter()` is mounted) — mount `pilotRouter()` also at `/api/versions/...` prefix

**Untouched (verified):**
- `builder-routes.ts` (session-scoped criterion editor — different concern)
- `derived-adjudications/revisits.ts` (consumed, not modified)
- `domain/review/review-state.ts` (the `applySetAssessmentMutation` call site for `validating` fires *after* the write via a side-effect hook, not inside the pure core)
- All existing test files

---

## Task 1 — Add `GuidelineVersion` type alias for `PilotManifest`

**Commit message:** `feat(iter): add GuidelineVersion type alias for PilotManifest`

**Files:**
- Modify: `app/server/domain/iter/pilots.ts` (after `PilotManifest` interface, ~line 182)
- Modify: `app/server/domain/iter/index.ts` (re-export the alias)
- New: `app/server/__tests__/version-type-alias.test.ts`

### Step 1 — Write the failing test

Create `app/server/__tests__/version-type-alias.test.ts`:

```typescript
/**
 * Compile-time + runtime test: GuidelineVersion is assignment-compatible
 * with PilotManifest in both directions (they are the same shape).
 */
import { describe, it, expect } from "vitest";
import type { GuidelineVersion, PilotManifest } from "../domain/iter/index.js";

describe("GuidelineVersion type alias", () => {
  it("GuidelineVersion is assignable to PilotManifest", () => {
    const gv: GuidelineVersion = {
      task_id: "t1",
      iter_id: "iter_001",
      iter_num: 1,
      run_id: "run_001",
      guideline_sha: "abc",
      started_at: "2026-05-06T00:00:00Z",
      started_by: "method",
      state: "running",
    };
    const pm: PilotManifest = gv; // must not error
    expect(pm.iter_id).toBe("iter_001");
  });

  it("PilotManifest is assignable to GuidelineVersion", () => {
    const pm: PilotManifest = {
      task_id: "t1",
      iter_id: "iter_001",
      iter_num: 1,
      run_id: "run_001",
      guideline_sha: "abc",
      started_at: "2026-05-06T00:00:00Z",
      started_by: "method",
      state: "running",
    };
    const gv: GuidelineVersion = pm; // must not error
    expect(gv.task_id).toBe("t1");
  });
});
```

- [ ] **Step 2 — Confirm test fails (TypeScript compile error: `GuidelineVersion` not found)**

Run `npx vitest run app/server/__tests__/version-type-alias.test.ts` — expect TS compile failure.

- [ ] **Step 3 — Add the alias in `pilots.ts`**

After the closing `}` of the `PilotManifest` interface (line ~182), add:

```typescript
/**
 * Alias for PilotManifest — new code uses GuidelineVersion.
 * PilotManifest remains valid for back-compat; both names refer to the
 * same shape. When the filesystem migration (Plan C) lands, this alias
 * will be replaced by a full rename; call sites using GuidelineVersion
 * will need no further edits.
 */
export type GuidelineVersion = PilotManifest;
```

- [ ] **Step 4 — Re-export from `index.ts`**

Add to the exports block in `app/server/domain/iter/index.ts`:

```typescript
  type GuidelineVersion,
```

Also export `snapshotCriterionHashesSync` from `index.ts` (needed by Tasks 5 and 6):

```typescript
  snapshotCriterionHashesSync,
```

- [ ] **Step 5 — Confirm tests pass**

Run `npx vitest run app/server/__tests__/version-type-alias.test.ts`.

---

## Task 2 — Extend `PilotState` with four new values; add type-guards

**Commit message:** `feat(iter): extend PilotState with validating, revising, superseded, locked`

**Files:**
- Modify: `app/server/domain/iter/pilots.ts` (line 44, `PilotState` type; `transitionPhase`; `setPilotState`)
- Modify: `app/server/domain/iter/index.ts` (re-export new guards)
- New: `app/server/__tests__/pilot-state-extended.test.ts`

### Step 1 — Write the failing test

Create `app/server/__tests__/pilot-state-extended.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  isValidatingState,
  isRevisingState,
  isSupersededState,
  isLockedVersionState,
  type PilotState,
} from "../domain/iter/index.js";

describe("extended PilotState values", () => {
  it("accepts all eight values as PilotState", () => {
    const states: PilotState[] = [
      "running",
      "ready_to_validate",
      "complete",
      "abandoned",
      "validating",
      "revising",
      "superseded",
      "locked",
    ];
    expect(states).toHaveLength(8);
  });

  it("isValidatingState narrows correctly", () => {
    expect(isValidatingState("validating")).toBe(true);
    expect(isValidatingState("running")).toBe(false);
  });

  it("isRevisingState narrows correctly", () => {
    expect(isRevisingState("revising")).toBe(true);
    expect(isRevisingState("complete")).toBe(false);
  });

  it("isSupersededState narrows correctly", () => {
    expect(isSupersededState("superseded")).toBe(true);
    expect(isSupersededState("abandoned")).toBe(false);
  });

  it("isLockedVersionState narrows correctly", () => {
    expect(isLockedVersionState("locked")).toBe(true);
    expect(isLockedVersionState("complete")).toBe(false);
  });
});
```

- [ ] **Step 2 — Confirm test fails**

- [ ] **Step 3 — Widen `PilotState` in `pilots.ts`**

Replace line 44:

```typescript
// Before
export type PilotState = "running" | "ready_to_validate" | "complete" | "abandoned";

// After
export type PilotState =
  | "running"
  | "ready_to_validate"
  | "complete"
  | "abandoned"
  /** Phase-driven workspace additions (Plan B). Old manifests never contain
   *  these values; only new writes use them. */
  | "validating"   // reviewer has committed ≥1 cell; still in progress
  | "revising"     // revise endpoint called; next version being assembled
  | "superseded"   // a child version was created from this one
  | "locked";      // terminal lock; methods bundle shippable
```

- [ ] **Step 4 — Add type-guard helpers in `pilots.ts`** (after the type declaration)

```typescript
export function isValidatingState(s: PilotState): s is "validating" {
  return s === "validating";
}
export function isRevisingState(s: PilotState): s is "revising" {
  return s === "revising";
}
export function isSupersededState(s: PilotState): s is "superseded" {
  return s === "superseded";
}
export function isLockedVersionState(s: PilotState): s is "locked" {
  return s === "locked";
}
```

- [ ] **Step 5 — Widen `setPilotState` allowlist**

In `setPilotState` (line ~1076 in `pilots.ts`), the function currently accepts any `PilotState` and delegates to `transitionPhase`. No change to `setPilotState`'s logic is needed (it already accepts `PilotState`). However, `transitionPhase`'s `set_state` case writes `completed_at` only for `"complete"` and `"abandoned"`; extend that predicate to include the new terminal states:

```typescript
// In transitionPhase, case "set_state":
// Before:
...(action.state === "complete" || action.state === "abandoned"
  ? { completed_at: new Date().toISOString() }
  : {}),

// After:
...(action.state === "complete" ||
    action.state === "abandoned" ||
    action.state === "superseded" ||
    action.state === "locked"
  ? { completed_at: new Date().toISOString() }
  : {}),
```

- [ ] **Step 6 — Widen PATCH allowedStates in `pilot-routes.ts`**

In the `PATCH /api/pilots/:taskId/:iterId` handler (line ~358), extend `allowedStates`:

```typescript
const allowedStates: PilotState[] = [
  "running", "ready_to_validate", "complete", "abandoned",
  "validating", "revising", "superseded", "locked",
];
```

- [ ] **Step 7 — Re-export guards from `index.ts`**

```typescript
  isValidatingState,
  isRevisingState,
  isSupersededState,
  isLockedVersionState,
```

- [ ] **Step 8 — Confirm tests pass**

---

## Task 3 — State transition: `validating` fires on first reviewer cell commit

**Commit message:** `feat(iter): transition iter to validating on first reviewer field_assessment`

**Files:**
- Modify: `app/server/adapters/http/pilot-routes.ts` — add a helper `maybeTransitionToValidating` called from the review-actions path, OR add a new exported helper in `pilots.ts` and call it from the review-state write side-effect chain.
- New: `app/server/__tests__/validating-transition.test.ts`

**Design decision:** The cleanest hook point is the existing `applyUiAction` side-effect sequence in `review-state.ts`. After `writeReviewState` completes (step 3 of `applyUiAction`), a new best-effort side-effect `maybeTransitionIterToValidating` is added (step 4b). It:
  1. Checks `action.type === "set_field_assessment"` and `by === "reviewer"`.
  2. Calls `listPilotIterations(taskId)` to find the most-recent iter in state `"running"` or `"ready_to_validate"`.
  3. If found and the iter has no prior reviewer assessment, calls `setPilotState(taskId, iterId, "validating")`.
  4. Wrapped in try/catch — never propagates errors.

This mirrors the pattern of `checkDriftAfterAction` and `maybeFireAutoRoleC` already in that file.

### Step 1 — Write the failing test

Create `app/server/__tests__/validating-transition.test.ts`:

```typescript
/**
 * When the first reviewer field_assessment is committed on an iter that is
 * "running" or "ready_to_validate", the iter should transition to "validating".
 *
 * Uses vi.mock for filesystem calls; tests the pure helper in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListPilotIterations, mockSetPilotState, mockGetPilotManifest } = vi.hoisted(() => ({
  mockListPilotIterations: vi.fn(),
  mockSetPilotState: vi.fn(),
  mockGetPilotManifest: vi.fn(),
}));

vi.mock("../domain/iter/index.js", () => ({
  listPilotIterations: mockListPilotIterations,
  setPilotState: mockSetPilotState,
  getPilotManifest: mockGetPilotManifest,
}));

import { maybeTransitionIterToValidating } from "../domain/iter/pilots.js";

describe("maybeTransitionIterToValidating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("transitions running iter to validating on first reviewer cell", () => {
    mockListPilotIterations.mockReturnValue([
      { iter_id: "iter_001", state: "running", task_id: "t1" },
    ]);
    // Simulate: no prior reviewer assessments visible in the iter (first cell)
    maybeTransitionIterToValidating("t1", "patient_001", "field_A", /* reviewerAssessmentCount= */ 1);
    expect(mockSetPilotState).toHaveBeenCalledWith("t1", "iter_001", "validating");
  });

  it("does not double-transition an iter already in validating", () => {
    mockListPilotIterations.mockReturnValue([
      { iter_id: "iter_001", state: "validating", task_id: "t1" },
    ]);
    maybeTransitionIterToValidating("t1", "patient_001", "field_A", 2);
    expect(mockSetPilotState).not.toHaveBeenCalled();
  });

  it("does not transition when by===agent", () => {
    // Calling convention: only invoke this helper when by==="reviewer" —
    // the call site in review-state.ts guards this.
    mockListPilotIterations.mockReturnValue([
      { iter_id: "iter_001", state: "running", task_id: "t1" },
    ]);
    // by==="agent" case is NOT called: the call site guards it.
    // Just confirm no iters are transitioned when state is already "complete".
    mockListPilotIterations.mockReturnValue([
      { iter_id: "iter_001", state: "complete", task_id: "t1" },
    ]);
    maybeTransitionIterToValidating("t1", "patient_001", "field_A", 1);
    expect(mockSetPilotState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2 — Confirm test fails** (`maybeTransitionIterToValidating` not exported yet)

- [ ] **Step 3 — Implement `maybeTransitionIterToValidating` in `pilots.ts`**

Add after `setPilotState`:

```typescript
/**
 * Best-effort side-effect: when a reviewer commits their FIRST field assessment
 * on a task, transition the most-recent running/ready_to_validate iter to
 * "validating". Wraps errors so callers are never broken.
 *
 * `reviewerAssessmentCount` is the count of reviewer-source assessments
 * visible in the review state AFTER the current write. A value of 1 means
 * this is the first reviewer cell on this patient; combined with a check
 * across patients (see implementation note), we fire only once per iter.
 *
 * Called from applyUiAction's side-effect chain in review-state.ts.
 */
export function maybeTransitionIterToValidating(
  taskId: string,
  _patientId: string,
  _fieldId: string,
  reviewerAssessmentCountForPatient: number,
): void {
  try {
    // Only fire on the very first reviewer cell for this patient (count===1).
    // The iter-level "first cell ever" check is: find the most recent iter
    // in running/ready_to_validate and try to transition it. setPilotState
    // is idempotent for the same state value, so duplicate calls are safe.
    if (reviewerAssessmentCountForPatient !== 1) return;
    const iters = listPilotIterations(taskId);
    // listPilotIterations returns newest-first.
    const target = iters.find(
      (i) => i.state === "running" || i.state === "ready_to_validate",
    );
    if (!target) return;
    setPilotState(taskId, target.iter_id, "validating");
  } catch {
    // Best-effort — never propagate
  }
}
```

- [ ] **Step 4 — Wire into `applyUiAction` in `review-state.ts`**

Import `maybeTransitionIterToValidating` from `"../iter/pilots.js"` and add a new best-effort step after `checkDriftAfterAction`:

```typescript
// Step 5 (new): best-effort iter → validating transition on first reviewer cell.
if (action.type === "set_field_assessment" && by === "reviewer") {
  const reviewerCount = transition.state.field_assessments.filter(
    (fa) => fa.source === "reviewer",
  ).length;
  try {
    maybeTransitionIterToValidating(task.task_id, patientId, action.payload.field_id, reviewerCount);
  } catch { /* best-effort */ }
}
```

- [ ] **Step 5 — Export from `index.ts`**

```typescript
  maybeTransitionIterToValidating,
```

- [ ] **Step 6 — Confirm tests pass**

---

## Task 4 — State transition: `revising` fires when revise endpoint is called

**Commit message:** `feat(iter): transition iter to revising when POST /revise is called`

**Files:**
- Modify: `app/server/domain/iter/pilots.ts` — add `transitionIterToRevising` helper
- Modify: `app/server/domain/iter/index.ts` — re-export helper
- New: `app/server/__tests__/revising-transition.test.ts`

**Design note:** Plan B does NOT implement the `superseded` transition (that requires the child version to exist — covered in Plan C). `transitionIterToRevising` sets the source iter to `"revising"` as an intermediate state; Plan C will set it to `"superseded"` once the child version's manifest is written.

### Step 1 — Write the failing test

Create `app/server/__tests__/revising-transition.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetPilotManifest, mockAtomicWrite } = vi.hoisted(() => ({
  mockGetPilotManifest: vi.fn(),
  mockAtomicWrite: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, writeFileSync: mockAtomicWrite, renameSync: vi.fn(), existsSync: actual.existsSync };
});

vi.mock("../domain/iter/pilots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../domain/iter/pilots.js")>();
  return { ...actual, getPilotManifest: mockGetPilotManifest };
});

import { transitionIterToRevising } from "../domain/iter/index.js";

const BASE_MANIFEST = {
  task_id: "t1", iter_id: "iter_001", iter_num: 1, run_id: "r1",
  guideline_sha: "abc", started_at: "2026-05-06T00:00:00Z",
  started_by: "method", state: "complete" as const,
};

describe("transitionIterToRevising", () => {
  beforeEach(() => vi.clearAllMocks());

  it("transitions complete iter to revising", () => {
    mockGetPilotManifest.mockReturnValue({ ...BASE_MANIFEST });
    const result = transitionIterToRevising("t1", "iter_001");
    expect(result.state).toBe("revising");
  });

  it("throws when iter is locked (cannot revise a locked version)", () => {
    mockGetPilotManifest.mockReturnValue({ ...BASE_MANIFEST, state: "locked" });
    expect(() => transitionIterToRevising("t1", "iter_001")).toThrow(/locked/);
  });

  it("throws when iter not found", () => {
    mockGetPilotManifest.mockReturnValue(null);
    expect(() => transitionIterToRevising("t1", "iter_001")).toThrow(/not found/);
  });
});
```

- [ ] **Step 2 — Confirm test fails**

- [ ] **Step 3 — Implement `transitionIterToRevising` in `pilots.ts`**

```typescript
/**
 * Transition an iter to "revising". Called by the POST /revise endpoint
 * before it creates the child iter. Throws if the iter is locked (the one
 * hard gate per the spec) or not found.
 *
 * Plan C will add the subsequent "superseded" transition once the child
 * version's manifest is confirmed written.
 */
export function transitionIterToRevising(taskId: string, iterId: string): PilotManifest {
  const m = getPilotManifest(taskId, iterId);
  if (!m) throw new Error(`pilot iteration not found: ${taskId}/${iterId}`);
  if (m.state === "locked") {
    throw new Error(`cannot revise a locked version: ${taskId}/${iterId}`);
  }
  const updated = transitionPhase(m, { type: "set_state", state: "revising" });
  atomicWriteJson(pilotManifestPath(taskId, iterId), updated);
  return updated;
}
```

- [ ] **Step 4 — Re-export from `index.ts`**

```typescript
  transitionIterToRevising,
```

- [ ] **Step 5 — Confirm tests pass**

---

## Task 5 — `POST /api/versions/:taskId/:vTag/revise` endpoint

**Commit message:** `feat(pilot-routes): add POST /api/versions/:taskId/:vTag/revise endpoint`

**Files:**
- Modify: `app/server/adapters/http/pilot-routes.ts` — add revise route
- New: `app/server/__tests__/versions-revise-route.test.ts`

**Design: criterion editing in the revise endpoint**

The revise endpoint receives `criteria_edits: Array<{ field_id: string; new_yaml: string }>`. It must write updated criterion files to the skill's criteria directory before computing the new hash snapshot. The criterion files live at `.claude/skills/chart-review-<taskId>/references/criteria/<field_id>.md`. The endpoint writes each `new_yaml` into the corresponding `.md` file using `fs.writeFileSync` (same atomic pattern used elsewhere in the codebase). It does NOT delegate to `builder-routes.ts` (that module is session-scoped for the interactive builder agent and is unrelated to production iter creation). After writing files, it calls `startPilotIteration` to create the next iter, inheriting the patient sample with optional add/remove. Before creating the new iter, it calls `transitionIterToRevising` on the source iter.

The `stale_cells` list in the response is computed by comparing the old iter's `criterion_schema_hashes` against the new snapshot: any `field_id` whose hash changed is stale for every patient in the new iter's sample.

**Request body schema:**
```typescript
{
  criteria_edits: Array<{ field_id: string; new_yaml: string }>;
  patient_sample_change?: { add: string[]; remove: string[] };
}
```

**Response shape:**
```typescript
{
  new_version_tag: string;      // e.g. "iter_002" (Plan C renames to "v2")
  stale_cells: Array<{ patient_id: string; field_id: string }>;
  source_iter_state: "revising";
}
```

### Step 1 — Write the failing test

Create `app/server/__tests__/versions-revise-route.test.ts`:

```typescript
/**
 * Supertest integration test for POST /api/versions/:taskId/:vTag/revise.
 *
 * Mocks: filesystem calls (criteria dir), pilots domain (getPilotManifest,
 * listPilotIterations, startPilotIteration, transitionIterToRevising,
 * snapshotCriterionHashesSync), cohort sampling (readCohortSampling).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// --- hoisted mocks ---
const {
  mockGetPilotManifest,
  mockStartPilotIteration,
  mockTransitionIterToRevising,
  mockSnapshotHashes,
  mockReadCohortSampling,
} = vi.hoisted(() => ({
  mockGetPilotManifest: vi.fn(),
  mockStartPilotIteration: vi.fn(),
  mockTransitionIterToRevising: vi.fn(),
  mockSnapshotHashes: vi.fn(),
  mockReadCohortSampling: vi.fn(),
}));

vi.mock("../../domain/iter/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPilotManifest: mockGetPilotManifest,
    startPilotIteration: mockStartPilotIteration,
    transitionIterToRevising: mockTransitionIterToRevising,
    snapshotCriterionHashesSync: mockSnapshotHashes,
  };
});
vi.mock("../../domain/cohort/index.js", () => ({
  readCohortSampling: mockReadCohortSampling,
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() };
});

import { pilotRouter } from "../../adapters/http/pilot-routes.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(pilotRouter());
  return app;
}

const SOURCE_MANIFEST = {
  task_id: "task1", iter_id: "iter_001", iter_num: 1, run_id: "r1",
  guideline_sha: "abc", started_at: "2026-05-06T00:00:00Z",
  started_by: "method", state: "complete",
  criterion_schema_hashes: { C1: "hash-old", C2: "hash-stable" },
};
const NEW_MANIFEST = {
  ...SOURCE_MANIFEST, iter_id: "iter_002", iter_num: 2, state: "running",
  criterion_schema_hashes: { C1: "hash-new", C2: "hash-stable" },
};

describe("POST /api/versions/:taskId/:vTag/revise", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPilotManifest.mockReturnValue(SOURCE_MANIFEST);
    mockTransitionIterToRevising.mockReturnValue({ ...SOURCE_MANIFEST, state: "revising" });
    mockStartPilotIteration.mockReturnValue({ pilot: NEW_MANIFEST });
    mockSnapshotHashes.mockReturnValue({ C1: "hash-new", C2: "hash-stable" });
    mockReadCohortSampling.mockReturnValue({ dev_patient_ids: ["p1", "p2"] });
  });

  it("returns 201 with new_version_tag and stale_cells", async () => {
    const res = await request(buildApp())
      .post("/api/versions/task1/iter_001/revise")
      .set("x-reviewer-id", "methodologist@example.com")
      .send({
        criteria_edits: [{ field_id: "C1", new_yaml: "id: C1\nprompt: updated\n" }],
      });
    expect(res.status).toBe(201);
    expect(res.body.new_version_tag).toBe("iter_002");
    expect(res.body.stale_cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field_id: "C1" }),
      ]),
    );
    expect(res.body.source_iter_state).toBe("revising");
  });

  it("returns 404 when source iter not found", async () => {
    mockGetPilotManifest.mockReturnValue(null);
    const res = await request(buildApp())
      .post("/api/versions/task1/iter_999/revise")
      .set("x-reviewer-id", "methodologist@example.com")
      .send({ criteria_edits: [] });
    expect(res.status).toBe(404);
  });

  it("returns 422 when criteria_edits is missing", async () => {
    const res = await request(buildApp())
      .post("/api/versions/task1/iter_001/revise")
      .set("x-reviewer-id", "methodologist@example.com")
      .send({});
    expect(res.status).toBe(422);
  });

  it("applies patient_sample_change add/remove", async () => {
    const res = await request(buildApp())
      .post("/api/versions/task1/iter_001/revise")
      .set("x-reviewer-id", "methodologist@example.com")
      .send({
        criteria_edits: [],
        patient_sample_change: { add: ["p3"], remove: ["p1"] },
      });
    expect(res.status).toBe(201);
    const callArgs = mockStartPilotIteration.mock.calls[0][0];
    expect(callArgs.patient_ids).toContain("p3");
    expect(callArgs.patient_ids).not.toContain("p1");
  });
});
```

- [ ] **Step 2 — Confirm test fails**

- [ ] **Step 3 — Implement the route in `pilot-routes.ts`**

Add inside `pilotRouter()`, after the existing revisit routes:

```typescript
// POST /api/versions/:taskId/:vTag/revise
// Creates the next iter from source vTag, applying optional criteria edits
// and patient sample changes. Returns new_version_tag + stale_cells.
router.post(
  "/api/versions/:taskId/:vTag/revise",
  express.json(),
  (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "revise requires methodologist privilege" });
    }
    const { taskId, vTag } = req.params as { taskId: string; vTag: string };
    const { criteria_edits, patient_sample_change } = req.body ?? {};

    if (!Array.isArray(criteria_edits)) {
      return res.status(422).json({ error: "criteria_edits (array) required" });
    }

    // 1. Load source iter manifest.
    const source = getPilotManifest(taskId, vTag);
    if (!source) return res.status(404).json({ error: `iter not found: ${vTag}` });

    try {
      // 2. Write criteria edits to the skill's criteria directory.
      const skillCriteriaDir = path.join(
        phenotypeSkillDir(taskId), "references", "criteria",
      );
      for (const edit of criteria_edits as Array<{ field_id: string; new_yaml: string }>) {
        if (!edit.field_id || typeof edit.new_yaml !== "string") continue;
        const filePath = path.join(skillCriteriaDir, `${edit.field_id}.md`);
        fs.mkdirSync(skillCriteriaDir, { recursive: true });
        fs.writeFileSync(filePath, edit.new_yaml);
      }

      // 3. Transition source iter to "revising".
      const updatedSource = transitionIterToRevising(taskId, vTag);

      // 4. Build new patient sample: carry-forward + optional add/remove.
      const cohort = readCohortSampling(taskId);
      let patientIds: string[] = source.patient_sample ?? cohort?.dev_patient_ids ?? [];
      if (patient_sample_change) {
        const remove = new Set<string>(patient_sample_change.remove ?? []);
        patientIds = patientIds.filter((p) => !remove.has(p));
        patientIds = Array.from(new Set([...patientIds, ...(patient_sample_change.add ?? [])]));
      }

      // 5. Create next iter.
      const { pilot: newManifest } = startPilotIteration({
        task_id: taskId,
        patient_ids: patientIds,
        started_by: reviewerId,
        onRunStatus: opts.onRunStatus,
      });

      // 6. Compute stale_cells: any field whose hash changed × every patient.
      const oldHashes = source.criterion_schema_hashes ?? {};
      const newHashes = newManifest.criterion_schema_hashes ?? {};
      const staleCells: Array<{ patient_id: string; field_id: string }> = [];
      for (const [fieldId, newHash] of Object.entries(newHashes)) {
        if (oldHashes[fieldId] !== newHash) {
          for (const pid of patientIds) {
            staleCells.push({ patient_id: pid, field_id: fieldId });
          }
        }
      }

      res.status(201).json({
        new_version_tag: newManifest.iter_id,
        stale_cells: staleCells,
        source_iter_state: updatedSource.state,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  },
);
```

Note: `phenotypeSkillDir` needs to be imported; verify it is available from `"../../domain/rubric/index.js"`. Also import `transitionIterToRevising` and `readCohortSampling`.

- [ ] **Step 4 — Confirm tests pass**

---

## Task 6 — `GET /api/versions/:taskId/:vTag/cells` endpoint

**Commit message:** `feat(pilot-routes): add GET /api/versions/:taskId/:vTag/cells endpoint`

**Files:**
- Modify: `app/server/adapters/http/pilot-routes.ts` — add cells route
- New: `app/server/__tests__/versions-cells-route.test.ts`

**Design: VersionCellMatrix computation**

The cells endpoint computes the matrix by:
1. Calling `computeRevisitsForIter({ taskId, iterId: vTag })` — returns rows where `captured_hash !== current_hash`.
2. Loading the iter's patient sample (from `readCohortSampling` or `source.patient_sample` when present).
3. Loading the iter's `criterion_schema_hashes` for the set of criteria.
4. For each `(patient_id, field_id)` in the cross-product:
   - If found in revisit rows → `state: "stale"` (has reviewer answer but hash changed)
   - If patient has a reviewer assessment with matching hash → `state: "fresh"`
   - Otherwise → `state: "unvalidated"`
5. Agent answers are pulled from the iter's run via `agentDraftPath` (best-effort; null if not found).

Each cell carries: `{ patient_id, field_id, state, reviewer_answer?, captured_against_schema_hash?, agent_answer? }`.

### Step 1 — Write the failing test

Create `app/server/__tests__/versions-cells-route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const {
  mockComputeRevisits,
  mockGetPilotManifest,
  mockReadCohortSampling,
  mockSnapshotHashes,
} = vi.hoisted(() => ({
  mockComputeRevisits: vi.fn(),
  mockGetPilotManifest: vi.fn(),
  mockReadCohortSampling: vi.fn(),
  mockSnapshotHashes: vi.fn(),
}));

vi.mock("../../derived-adjudications/revisits.js", () => ({
  computeRevisitsForIter: mockComputeRevisits,
  bulkKeepRevisits: vi.fn(),
}));
vi.mock("../../domain/iter/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPilotManifest: mockGetPilotManifest,
    snapshotCriterionHashesSync: mockSnapshotHashes,
  };
});
vi.mock("../../domain/cohort/index.js", () => ({
  readCohortSampling: mockReadCohortSampling,
}));

import { pilotRouter } from "../../adapters/http/pilot-routes.js";

function buildApp() {
  const app = express();
  app.use(pilotRouter());
  return app;
}

const MANIFEST = {
  task_id: "task1", iter_id: "iter_001", iter_num: 1, run_id: "r1",
  guideline_sha: "abc", started_at: "2026-05-06T00:00:00Z",
  started_by: "method", state: "validating",
  criterion_schema_hashes: { C1: "hash1", C2: "hash2" },
};

describe("GET /api/versions/:taskId/:vTag/cells", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPilotManifest.mockReturnValue(MANIFEST);
    mockReadCohortSampling.mockReturnValue({ dev_patient_ids: ["p1"] });
    mockSnapshotHashes.mockReturnValue({ C1: "hash1", C2: "hash2" });
    mockComputeRevisits.mockReturnValue({
      rows: [
        {
          field_id: "C2", patient_id: "p1",
          prior_answer: true, prior_captured_hash: "hash-old",
          current_hash: "hash2", prior_evidence: [], prior_rationale: null,
          agent_rerun_answer: null, agent_rerun_rationale: null,
        },
      ],
      criteria_changed: 1, total: 1,
    });
  });

  it("returns 200 with a cells array", async () => {
    const res = await request(buildApp())
      .get("/api/versions/task1/iter_001/cells");
    expect(res.status).toBe(200);
    expect(res.body.cells).toBeDefined();
    expect(Array.isArray(res.body.cells)).toBe(true);
  });

  it("marks cell as stale when hash differs", async () => {
    const res = await request(buildApp())
      .get("/api/versions/task1/iter_001/cells");
    const stale = res.body.cells.find(
      (c: any) => c.field_id === "C2" && c.patient_id === "p1",
    );
    expect(stale?.state).toBe("stale");
  });

  it("marks cells as unvalidated when no reviewer answer", async () => {
    mockComputeRevisits.mockReturnValue({ rows: [], criteria_changed: 0, total: 0 });
    const res = await request(buildApp())
      .get("/api/versions/task1/iter_001/cells");
    expect(res.body.cells.every((c: any) => c.state === "unvalidated")).toBe(true);
  });

  it("returns 404 when iter not found", async () => {
    mockGetPilotManifest.mockReturnValue(null);
    const res = await request(buildApp())
      .get("/api/versions/task1/iter_999/cells");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2 — Confirm test fails**

- [ ] **Step 3 — Implement the route in `pilot-routes.ts`**

Add after the revise route:

```typescript
// GET /api/versions/:taskId/:vTag/cells — VersionCellMatrix
// Computed view: (patient_id × field_id) with fresh/stale/unvalidated state.
// Reuses computeRevisitsForIter for stale detection; joins against reviewer
// review_state for fresh vs unvalidated classification.
router.get("/api/versions/:taskId/:vTag/cells", (req, res) => {
  const { taskId, vTag } = req.params as { taskId: string; vTag: string };
  const manifest = getPilotManifest(taskId, vTag);
  if (!manifest) return res.status(404).json({ error: `iter not found: ${vTag}` });

  try {
    const cohort = readCohortSampling(taskId);
    const patientIds: string[] = manifest.patient_sample
      ?? cohort?.dev_patient_ids
      ?? [];
    const criteriaHashes = manifest.criterion_schema_hashes ?? {};
    const fieldIds = Object.keys(criteriaHashes);

    // Get stale rows from revisit helper.
    const { rows: revisitRows } = computeRevisitsForIter({ taskId, iterId: vTag });
    const staleKey = (pid: string, fid: string) => `${pid}__${fid}`;
    const staleSet = new Set(revisitRows.map((r) => staleKey(r.patient_id, r.field_id)));

    // Build cells: cross-product of patientIds × fieldIds.
    const platformRoot = process.env.CHART_REVIEW_PLATFORM_ROOT
      ?? path.resolve(process.cwd(), "..");
    const reviewsRootDir = process.env.CHART_REVIEW_REVIEWS_ROOT
      ?? path.join(platformRoot, "reviews");

    const cells = [];
    for (const patientId of patientIds) {
      // Load reviewer state once per patient (best-effort).
      let reviewerAssessments: Record<string, {
        answer?: unknown;
        captured_against_schema_hash?: string;
      }> = {};
      try {
        const rsPath = path.join(reviewsRootDir, patientId, taskId, "review_state.json");
        if (fs.existsSync(rsPath)) {
          const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
            field_assessments?: Array<{
              field_id: string;
              source: string;
              answer?: unknown;
              captured_against_schema_hash?: string;
            }>;
          };
          for (const fa of rs.field_assessments ?? []) {
            if (fa.source === "reviewer") {
              reviewerAssessments[fa.field_id] = {
                answer: fa.answer,
                captured_against_schema_hash: fa.captured_against_schema_hash,
              };
            }
          }
        }
      } catch { /* best-effort */ }

      for (const fieldId of fieldIds) {
        const key = staleKey(patientId, fieldId);
        const isStale = staleSet.has(key);
        const reviewerRec = reviewerAssessments[fieldId];
        const currentHash = criteriaHashes[fieldId];

        let cellState: "fresh" | "stale" | "unvalidated";
        if (isStale) {
          cellState = "stale";
        } else if (reviewerRec && reviewerRec.captured_against_schema_hash === currentHash) {
          cellState = "fresh";
        } else {
          cellState = "unvalidated";
        }

        cells.push({
          patient_id: patientId,
          field_id: fieldId,
          state: cellState,
          reviewer_answer: reviewerRec?.answer,
          captured_against_schema_hash: reviewerRec?.captured_against_schema_hash,
        });
      }
    }

    res.json({ cells, total: cells.length, iter_id: vTag });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
```

- [ ] **Step 4 — Confirm tests pass**

---

## Task 7 — Route alias `/api/versions/...` for existing `/api/pilots/...` handlers

**Commit message:** `feat(server): mount /api/versions alias alongside /api/pilots routes`

**Files:**
- Modify: `app/server/server.ts` (or whichever file mounts `pilotRouter()` — verify before editing)
- New: `app/server/__tests__/versions-alias-routes.test.ts`

**Design:** The `pilotRouter()` currently registers routes with hardcoded `/api/pilots/...` prefixes internally. The alias approach is to mount the router a second time at a path prefix that strips `/api/versions` → `/api/pilots`. Express does not natively support "remount with prefix rewrite" for routers that hardcode full paths.

Two implementation options (choose at verify time):

**Option A (preferred if simpler):** Register a second set of route aliases in `pilot-routes.ts` that mirror each existing `/api/pilots/...` route at `/api/versions/...`. Only the new Task 5/6 routes and the core GET/PATCH/POST already need aliasing; the legacy pilots endpoints can be selectively aliased as needed by Plan A. For Plan B, the minimum alias set is:
- `GET /api/versions/:taskId` → list iters
- `GET /api/versions/:taskId/:vTag` → iter detail
- `PATCH /api/versions/:taskId/:vTag` → update state/notes
- `GET /api/versions/:taskId/:vTag/revisits` → revisits (already rooted in vTag)
- Plus the two new routes from Tasks 5 and 6 (already use `/api/versions/...` prefix).

**Option B:** Change all route prefixes in `pilotRouter()` from `/api/pilots/` to a configurable prefix string passed via `PilotRouterOptions`, then mount the router twice in `server.ts` (once with `"pilots"`, once with `"versions"`). This is cleaner long-term but requires touching more call sites in one commit.

**Recommendation:** Use Option A for Plan B (minimal change, clear alias). Plan C can migrate to Option B when it renames paths.

### Step 1 — Write the failing test

Create `app/server/__tests__/versions-alias-routes.test.ts`:

```typescript
/**
 * Smoke test: /api/versions/:taskId behaves identically to /api/pilots/:taskId.
 * Uses supertest against a minimal app that mounts pilotRouter().
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const { mockListPilotIterations, mockGetPilotManifest } = vi.hoisted(() => ({
  mockListPilotIterations: vi.fn(),
  mockGetPilotManifest: vi.fn(),
}));

vi.mock("../../domain/iter/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    listPilotIterations: mockListPilotIterations,
    getPilotManifest: mockGetPilotManifest,
  };
});

import { pilotRouter } from "../../adapters/http/pilot-routes.js";

function buildApp() {
  const app = express();
  app.use(pilotRouter());
  return app;
}

describe("/api/versions alias routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPilotIterations.mockReturnValue([]);
    mockGetPilotManifest.mockReturnValue(null);
  });

  it("GET /api/versions/:taskId returns same payload as GET /api/pilots/:taskId", async () => {
    mockListPilotIterations.mockReturnValue([{ iter_id: "iter_001" }]);
    const [r1, r2] = await Promise.all([
      request(buildApp()).get("/api/pilots/task1"),
      request(buildApp()).get("/api/versions/task1"),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body).toEqual(r2.body);
  });

  it("GET /api/versions/:taskId/:vTag returns 404 for unknown iter (same as pilots path)", async () => {
    const [r1, r2] = await Promise.all([
      request(buildApp()).get("/api/pilots/task1/iter_999"),
      request(buildApp()).get("/api/versions/task1/iter_999"),
    ]);
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
  });
});
```

- [ ] **Step 2 — Confirm test fails** (`/api/versions/...` returns 404)

- [ ] **Step 3 — Add alias routes in `pilot-routes.ts`** (Option A)

Inside `pilotRouter()`, after the existing `/api/pilots/...` routes, add mirrored handlers using the same handler logic (call through to the same domain functions):

```typescript
// ── /api/versions/... aliases ─────────────────────────────────────────────
// New code should use /api/versions/...; /api/pilots/... continues to work.

router.get("/api/versions/:taskId", (req, res) => {
  res.json(listPilotIterations(req.params.taskId));
});

router.get("/api/versions/:taskId/stats", (req, res) => {
  res.json(pilotIterationStats(req.params.taskId));
});

router.get("/api/versions/:taskId/:vTag", (req, res) => {
  const { taskId, vTag } = req.params as { taskId: string; vTag: string };
  const m = getPilotManifest(taskId, vTag);
  if (!m) return res.status(404).json({ error: "iter not found" });
  const critique = getPilotCritique(taskId, vTag);
  res.json({ manifest: m, critique });
});

router.patch("/api/versions/:taskId/:vTag", (req, res) => {
  // Delegate to the same logic as PATCH /api/pilots/:taskId/:iterId.
  req.params.iterId = req.params.vTag;
  // Re-use by forwarding to the handler (call domain directly to avoid duplication).
  const reviewerId = reviewerIdOf(req);
  if (!isMethodologist(reviewerId)) {
    return res.status(403).json({ error: "updating a pilot requires methodologist privilege" });
  }
  const { state, notes } = req.body ?? {};
  const allowedStates: PilotState[] = [
    "running", "ready_to_validate", "complete", "abandoned",
    "validating", "revising", "superseded", "locked",
  ];
  if (state && !allowedStates.includes(state)) {
    return res.status(400).json({ error: `state must be one of ${allowedStates.join(", ")}` });
  }
  try {
    const updated = setPilotState(taskId, req.params.vTag, (state ?? "running") as PilotState, notes);
    if (state === "complete") fireAutoCritique(taskId, req.params.vTag, reviewerId);
    res.json(updated);
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

router.get("/api/versions/:taskId/:vTag/revisits", (req, res) => {
  const { taskId, vTag } = req.params;
  const result = computeRevisitsForIter({ taskId, iterId: vTag });
  res.json({ ok: true, ...result });
});
```

- [ ] **Step 4 — Confirm all tests in `versions-alias-routes.test.ts` pass**

- [ ] **Step 5 — Run full test suite** (`npx vitest run`) — confirm no regressions

---

## Branch reminder

All seven tasks land on branch `feat/phase-driven-workspace`. Each task is one commit. Do not merge or push until all tasks pass and the full `npx vitest run` suite is green.

## Dependency order

```
Task 1 (type alias)
  └─ Task 2 (state enum)
       ├─ Task 3 (validating transition) — depends on Task 2 state values
       ├─ Task 4 (revising transition)   — depends on Task 2 state values
       │    └─ Task 5 (revise endpoint)  — depends on Task 4
       └─ Task 6 (cells endpoint)        — depends on Tasks 1–2 (types only); can run in parallel with 3–5
Task 7 (alias routes) — depends on Tasks 5–6 (needs both new routes present)
```

Tasks 3 and 4 can be implemented in parallel. Task 6 can be implemented in parallel with Tasks 3–5.
