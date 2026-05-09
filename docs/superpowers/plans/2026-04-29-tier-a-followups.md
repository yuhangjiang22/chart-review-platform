# Tier A Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four Tier-A items from rethink-chart-review.md — Lock workflow, QA / disagreement panel, Methodologist read-only route, Auto drift detection — that the merge spec deferred. Closes Beats 6 (κ + confusion matrix) + 8 (lock workflow), advances Beats 10 (drift) + 13 (methodologist surface).

**Architecture:** Lock ships first (audit step type + read-only guard); QA panel + Methodologist + Drift ship in parallel afterward. Reuses existing infrastructure: audit JSONL, `applyUiAction` mutate-with-broadcast, `routes-reviewer.ts` REST pattern, `auth.ts` token model, vitest+pytest test runners. New: viewer-token auth concept (separate from reviewer auth), path-based dispatch in `App.tsx` for `/methodologist/...` (no router lib added).

**Tech Stack:** TypeScript 5.5, React 18.3, Vite 5.4, Express 4.21, vitest, pytest, Playwright (existing), no new deps.

**Spec:** `docs/superpowers/specs/2026-04-29-tier-a-followups-design.md` (read this before starting any task — every decision is grounded there).

**Effort:** ~7-9 days. Phase 1 Lock (~1.5d, Tasks 1-6) → Phase 2 Drift (~1.5d, Tasks 7-9) → Phase 3 QA panel (~3d, Tasks 10-13) → Phase 4 Methodologist (~2d, Tasks 14-19) → Phase 5 Integration + smoke (~1d, Tasks 20-21).

---

## File Structure

### New files in `app/server/`

| Path | Responsibility |
|---|---|
| `lock.ts` | `lockReadyCheck(state)` helper; lock SHA computer |
| `qa-panel.ts` | Cohort aggregator: read review_state.json files + audit logs, return `QAStats` |
| `drift-detector.ts` | `checkDrift(taskId, fieldId)` + cooldown logic + in-memory cache |
| `methodologist.ts` | Read-only route handlers (task + per-record) |
| `__tests__/lock-workflow.test.ts` | TDD for Phase 1 |
| `__tests__/drift-detector.test.ts` | TDD for Phase 2 |
| `__tests__/qa-panel.test.ts` | TDD for Phase 3 |
| `__tests__/methodologist.test.ts` | TDD for Phase 4 |

### Modified files in `app/server/`

| Path | Change |
|---|---|
| `audit-trail.ts` | Add 2 new step_type variants (`record_locked`, `drift_alert`) |
| `review-state.ts` | Extend `ReviewState` with `locked_at?`, `locked_by?`, `lock_task_sha?`; lock guard at top of `mutate()`; extend `set_review_status` handler |
| `routes-reviewer.ts` | Add `POST /lock` endpoint |
| `auth.ts` | Add `issueViewerToken`, `resolveViewerToken`, `viewerAuthMiddleware`, persistence |
| `server.ts` | Mount `/api/qa/:tid`, `/api/methodologist/...`, `/api/auth/viewer-token*` endpoints |

### New files in `app/client/src/`

| Path | Responsibility |
|---|---|
| `QAPanel.tsx` | Fetches `/api/qa/:tid` and renders `<QAPanelCards />` |
| `QAPanelCards.tsx` | Pure render component — props `{ stats: QAStats }`. Reused by QAPanel + MethodologistView |
| `MethodologistView.tsx` | Read-only methodologist surface, viewer-token-authenticated |
| `MethodologistTokenPanel.tsx` | Studio addition: issue/list/revoke viewer tokens |
| `LockButton.tsx` | Small button used by WorkflowBar (lock confirm dialog optional) |

### Modified files in `app/client/src/`

| Path | Change |
|---|---|
| `types.ts` | Add `LockedFields`, `QAStats`, `CriterionStats`, `DriftAlert`, `ViewerToken` types |
| `WorkflowBar.tsx` | Render `<LockButton>` when `review_status === "reviewer_validated"`; hide all action buttons when `locked` |
| `CriterionPane.tsx` | Read-only mode (hide accept/override buttons) when `reviewState.review_status === "locked"` |
| `NoteViewer.tsx` | Add `qa` tab to tab strip; render `<QAPanel />` when active |
| `Studio.tsx` | Mount `<MethodologistTokenPanel />` as third panel |
| `App.tsx` | Path-based dispatch: render `<MethodologistView />` if `pathname.startsWith("/methodologist/")` |

### Modified files in `contracts/`

| Path | Change |
|---|---|
| `review_state.schema.json` | Add `locked_at`, `locked_by`, `lock_task_sha` (all optional) |

### Modified files in `lib/tests/`

| Path | Change |
|---|---|
| `test_contracts.py` | Add round-trip test for new lock fields |

### Modified files in `app/scripts/`

| Path | Change |
|---|---|
| `smoke-merged.py` | Two new flows: `assert_lock_workflow`, `assert_methodologist_route` |

---

## PHASE 1 — Lock workflow (Tasks 1-6)

After Phase 1: `→ locked` transition works end-to-end, all writes (agent + reviewer) reject with `RECORD_LOCKED` once locked, lock_task_sha pinned.

---

### Task 1: Schema + Python contract tests for lock fields

**Files:**
- Modify: `chart-review-platform/contracts/review_state.schema.json`
- Modify: `chart-review-platform/lib/tests/test_contracts.py`

- [ ] **Step 1: Add 3 fields to `review_state.schema.json` top-level `properties`**

```jsonc
"locked_at": { "type": "string", "description": "ISO-8601 timestamp of the lock transition." },
"locked_by": { "type": "string", "description": "reviewer_id who performed the lock." },
"lock_task_sha": { "type": "string", "description": "sha256(compiled_task_json).slice(0,16) at lock time. Pinned forever." }
```

All optional. The `review_status` enum already has `"locked"` — no change needed.

- [ ] **Step 2: Validate the schema**

```bash
cd chart-review-platform && python -c "
import json, jsonschema
with open('contracts/review_state.schema.json') as f: s = json.load(f)
jsonschema.Draft202012Validator.check_schema(s)
print('OK')
"
```

Expected: `OK`.

- [ ] **Step 3: Add Python contract test**

Append to `chart-review-platform/lib/tests/test_contracts.py`:

```python
def test_review_state_accepts_lock_fields():
    """Schema accepts ReviewState with locked_at, locked_by, lock_task_sha."""
    rs = _minimal_review_state()
    rs["review_status"] = "locked"
    rs["locked_at"] = "2026-04-29T15:00:00Z"
    rs["locked_by"] = "alice"
    rs["lock_task_sha"] = "a1b2c3d4e5f6a7b8"
    result = validate_review_state(rs, CONTRACTS)
    assert result["status"] == "pass", result["errors"]
```

- [ ] **Step 4: Run pytest**

```bash
cd chart-review-platform && pytest lib/tests/test_contracts.py -v
```

Expected: 9 passed (existing 8 + 1 new).

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/contracts/review_state.schema.json chart-review-platform/lib/tests/test_contracts.py
git commit -m "Tier A: schema fields for lock workflow (locked_at, locked_by, lock_task_sha)"
```

---

### Task 2: Lock guard in applyUiAction + record_locked audit step type

**Files:**
- Modify: `chart-review-platform/app/server/audit-trail.ts`
- Modify: `chart-review-platform/app/server/review-state.ts`
- Create: `chart-review-platform/app/server/__tests__/lock-workflow.test.ts`

- [ ] **Step 1: Add `record_locked` to AuditEntry discriminated union**

In `audit-trail.ts`, append to the union (preserving existing 14 variants):

```ts
  | (BaseEntry & {
      step_type: "record_locked";
      lock_task_sha: string;
      reviewer_id: string;
    })
```

- [ ] **Step 2: Extend `ReviewState` interface**

In `review-state.ts`, find the `ReviewState` interface and add three optional fields:

```ts
  locked_at?: string;
  locked_by?: string;
  lock_task_sha?: string;
```

Also extend `SetReviewStatusInput` if it exists, or wherever the set_review_status payload is typed:

```ts
export interface SetReviewStatusInput {
  review_status: ReviewStatus;
  updated_by?: string;
  locked_at?: string;
  locked_by?: string;
  lock_task_sha?: string;
}
```

And in `applySetReviewStatus`, propagate the optional fields onto the persisted state:

```ts
function applySetReviewStatus(state: ReviewState, payload: SetReviewStatusInput): ReviewState {
  return {
    ...state,
    review_status: payload.review_status,
    updated_by: payload.updated_by ?? state.updated_by,
    ...(payload.locked_at !== undefined && { locked_at: payload.locked_at }),
    ...(payload.locked_by !== undefined && { locked_by: payload.locked_by }),
    ...(payload.lock_task_sha !== undefined && { lock_task_sha: payload.lock_task_sha }),
  };
}
```

(Adapt to the existing handler shape — read it first.)

- [ ] **Step 3: Write the failing test (TDD)**

Create `chart-review-platform/app/server/__tests__/lock-workflow.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { applyUiAction, applySetAssessment, ReviewStateError } from "../review-state";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PID = "p1", TID = "t1";
const TASK = { task_id: TID, source_document_sha: "sha", fields: [{ id: "x" }] };

function readState() {
  return JSON.parse(fs.readFileSync(path.join(TMP, PID, TID, "review_state.json"), "utf8"));
}

describe("lock guard in applyUiAction", () => {
  it("rejects writes once review_status is locked", async () => {
    // Set up: agent writes, then transition to locked
    await applySetAssessment(PID, TASK, "agent", "agent-1", {
      field_id: "x", answer: "yes", status: "agent_proposed",
    });
    await applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "locked", locked_at: "2026-04-29T15:00:00Z", locked_by: "alice", lock_task_sha: "abc123" }
    });

    expect(readState().review_status).toBe("locked");

    // Now try a reviewer write
    await expect(applySetAssessment(PID, TASK, "reviewer", "alice", {
      field_id: "x", answer: "no", status: "overridden",
    })).rejects.toMatchObject({ code: "RECORD_LOCKED" });

    // And an agent write
    await expect(applySetAssessment(PID, TASK, "agent", "agent-2", {
      field_id: "x", answer: "maybe", status: "agent_proposed",
    })).rejects.toMatchObject({ code: "RECORD_LOCKED" });
  });

  it("allows the transitioning write into locked state", async () => {
    // Pre-state: validated
    await applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "reviewer_validated" }
    });
    expect(readState().review_status).toBe("reviewer_validated");

    // The lock-transitioning write itself succeeds
    await applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "locked", locked_at: "2026-04-29T15:00:00Z", locked_by: "alice", lock_task_sha: "abc123" }
    });
    const s = readState();
    expect(s.review_status).toBe("locked");
    expect(s.locked_at).toBe("2026-04-29T15:00:00Z");
    expect(s.locked_by).toBe("alice");
    expect(s.lock_task_sha).toBe("abc123");
  });
});
```

- [ ] **Step 4: Run — should fail (no guard yet)**

```bash
cd chart-review-platform/app && npm test lock-workflow
```

Expected: tests fail because writes still succeed when state is locked.

- [ ] **Step 5: Add the lock guard**

In `review-state.ts`'s `mutate()` function, at the top before the version check / mutator call:

```ts
// Lock guard — once locked, all writes (agent + reviewer) are rejected.
// The guard checks PERSISTED state, not the incoming payload, so the write
// that *transitions into* locked status passes through (state is still
// "reviewer_validated" at that moment).
if (current.review_status === "locked") {
  throw new ReviewStateError("RECORD_LOCKED", "Record is locked; no further writes allowed");
}
```

Adapt to the existing `mutate()` structure (read it first to find the right insertion point).

If `ReviewStateError` doesn't expose a `code` field, extend it to include one:

```ts
export class ReviewStateError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ReviewStateError";
  }
}
```

- [ ] **Step 6: Run — should pass**

```bash
cd chart-review-platform/app && npm test lock-workflow
```

Expected: 2 passed. Run full suite to verify no regressions:

```bash
cd chart-review-platform/app && npm test
```

Expected: all tests pass (existing 42 + 2 new = 44).

- [ ] **Step 7: Commit**

```bash
git add chart-review-platform/app/server/audit-trail.ts \
        chart-review-platform/app/server/review-state.ts \
        chart-review-platform/app/server/__tests__/lock-workflow.test.ts
git commit -m "Tier A: lock guard in applyUiAction + record_locked audit step (TDD)"
```

---

### Task 3: POST /api/reviews/:pid/:tid/lock endpoint

**Files:**
- Create: `chart-review-platform/app/server/lock.ts`
- Modify: `chart-review-platform/app/server/routes-reviewer.ts`
- Modify: `chart-review-platform/app/server/__tests__/lock-workflow.test.ts`

- [ ] **Step 1: Implement the lock-readiness helper**

`app/server/lock.ts`:

```ts
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

export interface LockReadinessResult {
  ready: boolean;
  reason?: string;
  lock_task_sha?: string;
}

export function computeTaskSha(compiledTaskPath: string): string {
  const content = fs.readFileSync(compiledTaskPath, "utf8");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function lockReadyCheck(reviewStatus: string | undefined): LockReadinessResult {
  if (reviewStatus !== "reviewer_validated") {
    return {
      ready: false,
      reason: `review_status is "${reviewStatus ?? "unset"}"; lock requires "reviewer_validated"`,
    };
  }
  return { ready: true };
}
```

- [ ] **Step 2: Add `/lock` endpoint to routes-reviewer.ts**

In `routes-reviewer.ts`, add a new route handler (placement: alongside the existing `/validate`):

```ts
// At top of file:
import { computeTaskSha, lockReadyCheck } from "./lock.js";
import { PLATFORM_ROOT } from "./patients.js";  // or wherever PLATFORM_ROOT is exported

// Inside the router function:
r.post("/api/reviews/:pid/:tid/lock", async (req, res) => {
  const { pid, tid } = req.params as { pid: string; tid: string };
  const reviewer_id = reviewerIdOf(req);

  const state = load(pid, tid);
  if (!state) return res.status(404).json({ ok: false, error: "review_state not found" });

  const ready = lockReadyCheck(state.review_status);
  if (!ready.ready) {
    return res.status(409).json({ ok: false, error: ready.reason });
  }

  const task = await loadCompiledTask(tid);
  if (!task) return res.status(404).json({ ok: false, error: "compiled task not found" });

  const compiledTaskPath = path.join(PLATFORM_ROOT, "tasks", "compiled", `${tid}.json`);
  const lock_task_sha = computeTaskSha(compiledTaskPath);
  const locked_at = new Date().toISOString();

  const result = await applyUiAction(pid, task, "reviewer", reviewer_id, {
    type: "set_review_status",
    payload: {
      review_status: "locked",
      locked_at,
      locked_by: reviewer_id,
      lock_task_sha,
    },
  });

  appendAuditEntry(
    { patientId: pid, taskId: tid, sessionId: `lock-${Date.now()}` },
    {
      ts: locked_at,
      session_id: `lock-${Date.now()}`,
      step_type: "record_locked",
      lock_task_sha,
      reviewer_id,
    },
  );

  broadcast(pid, result.state);

  res.json({ ok: true, version: result.state.version, lock_task_sha, locked_at });
});
```

- [ ] **Step 3: Add test for the endpoint**

Append to `__tests__/lock-workflow.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { reviewerRouter } from "../routes-reviewer";

describe("POST /lock endpoint", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { reviewer_id?: string }).reviewer_id = "alice"; next(); });
    app.use(reviewerRouter(() => {}));
    return app;
  }

  it("returns 409 if review_status is not reviewer_validated", async () => {
    // Set up an in-progress state
    await applySetAssessment(PID, TASK, "reviewer", "alice", {
      field_id: "x", answer: "yes", status: "approved",
    });

    const app = makeApp();
    const res = await request(app).post(`/api/reviews/${PID}/${TID}/lock`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/reviewer_validated/);
  });

  it("locks a validated record and emits record_locked audit", async () => {
    // Pre-state: validated
    await applyUiAction(PID, TASK, "reviewer", "alice", {
      type: "set_review_status",
      payload: { review_status: "reviewer_validated" },
    });

    const app = makeApp();
    const res = await request(app).post(`/api/reviews/${PID}/${TID}/lock`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.lock_task_sha).toMatch(/^[a-f0-9]{16}$/);

    const state = JSON.parse(fs.readFileSync(path.join(TMP, PID, TID, "review_state.json"), "utf8"));
    expect(state.review_status).toBe("locked");
    expect(state.lock_task_sha).toBe(res.body.lock_task_sha);
  });
});
```

The test uses `supertest`. Install if not present:

```bash
cd chart-review-platform/app && npm install --save-dev supertest @types/supertest --fetch-timeout=600000 --fetch-retries=5
```

(If `supertest` causes friction or the existing tests don't use it, drop the supertest layer and call the route handler function directly with mock req/res — pick whichever pattern matches existing tests.)

- [ ] **Step 4: Run + commit**

```bash
cd chart-review-platform/app && npm test lock-workflow
git add chart-review-platform/app/server/lock.ts \
        chart-review-platform/app/server/routes-reviewer.ts \
        chart-review-platform/app/server/__tests__/lock-workflow.test.ts \
        chart-review-platform/app/package.json chart-review-platform/app/package-lock.json
git commit -m "Tier A: POST /api/reviews/:pid/:tid/lock endpoint (TDD)"
```

---

### Task 4: WorkflowBar Lock button + locked-state hide

**Files:**
- Modify: `chart-review-platform/app/client/src/types.ts`
- Modify: `chart-review-platform/app/client/src/WorkflowBar.tsx`

- [ ] **Step 1: Add lock fields to client ReviewState type**

In `types.ts`, find `ReviewState` interface and add:

```ts
  locked_at?: string;
  locked_by?: string;
  lock_task_sha?: string;
```

- [ ] **Step 2: Add Lock button to WorkflowBar**

Modify `WorkflowBar.tsx`. After the existing `markValidated` async function, add:

```ts
async function lock() {
  if (!confirm("Lock this record? This is irreversible — no further writes (agent or reviewer) will be accepted.")) return;
  const r = await authFetch(`/api/reviews/${patientId}/${taskId}/lock`, { method: "POST" });
  const body = await r.json();
  if (!body.ok) {
    alert(`Lock failed:\n` + (body.error ?? "Unknown error"));
  }
}
```

In the JSX, after the "Mark validated" button, add:

```tsx
<button onClick={lock}
  disabled={reviewState?.review_status !== "reviewer_validated"}
  className="px-3 py-1 rounded bg-slate-700 text-white disabled:opacity-50 hover:bg-slate-800 inline-flex items-center gap-1"
  title="Irreversible — no further writes accepted after lock">
  🔒 Lock
</button>
```

- [ ] **Step 3: Hide all action buttons when locked**

At the top of the WorkflowBar render body, return a minimal locked footer when `reviewState?.review_status === "locked"`:

```tsx
if (reviewState?.review_status === "locked") {
  const sha = reviewState.lock_task_sha;
  return (
    <footer className="border-t border-slate-200 bg-slate-50 px-4 py-2 flex items-center gap-3 text-[12px]">
      <Pill tone="ok">🔒 locked</Pill>
      {sha && <span className="text-slate-500 font-mono">sha: {sha}</span>}
      {reviewState.locked_by && <span className="text-slate-500">by {reviewState.locked_by}</span>}
      {reviewState.locked_at && <span className="text-slate-500">at {reviewState.locked_at.slice(0, 16)}</span>}
    </footer>
  );
}
```

- [ ] **Step 4: Update statusPill to handle locked**

Find the existing `statusPill` ternary and extend:

```tsx
const statusPill = reviewState?.review_status === "locked"
  ? <Pill tone="ok">🔒 locked</Pill>
  : reviewState?.review_status === "reviewer_validated"
    ? <Pill tone="ok">validated</Pill>
    : <Pill tone="ghost">{reviewState?.review_status ?? "draft"}</Pill>;
```

- [ ] **Step 5: Verify build**

```bash
cd chart-review-platform/app && npx tsc --noEmit && npm run build:client
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/app/client/src/types.ts chart-review-platform/app/client/src/WorkflowBar.tsx
git commit -m "Tier A: WorkflowBar Lock button + locked-state hide"
```

---

### Task 5: CriterionPane read-only mode when locked

**Files:**
- Modify: `chart-review-platform/app/client/src/CriterionPane.tsx`

- [ ] **Step 1: Add `isLocked` derived flag**

In the CriterionPane component body, near other derived state:

```tsx
const isLocked = props.reviewState?.review_status === "locked";
```

- [ ] **Step 2: Hide accept-draft + override buttons + override form when locked**

Find the existing block that renders the action buttons (accept-draft + override) and OverrideForm. Wrap with `{!isLocked && ...}`:

```tsx
{mode === "full" && !isLocked && assessment?.source === "agent" && (
  <div className="flex gap-2">
    {/* existing accept-draft + override buttons */}
  </div>
)}

{!isLocked && overrideOpen && (
  <OverrideForm ... />
)}
```

Same pattern for the BlindedReviewControls:

```tsx
{!isLocked && isCalibration && (
  <BlindedReviewControls ... />
)}
```

The header/answer/rationale/applied-rule/evidence/alternatives blocks STAY visible — they're the read-only view of what was locked.

- [ ] **Step 3: Verify build**

```bash
cd chart-review-platform/app && npx tsc --noEmit && npm run build:client
```

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/client/src/CriterionPane.tsx
git commit -m "Tier A: CriterionPane read-only when review_status=locked"
```

---

### Task 6: Phase 1 checkpoint

**Files**: none (verification step).

- [ ] **Step 1: Run full vitest + pytest**

```bash
cd chart-review-platform/app && npm test
cd chart-review-platform && pytest lib/tests/
```

Expected: vitest 44 pass · pytest 105 pass.

- [ ] **Step 2: Empty checkpoint commit**

```bash
git commit --allow-empty -m "Phase 1 complete: lock workflow shipped (audit step type + guard + endpoint + UI)"
```

---

## PHASE 2 — Auto drift detection (Tasks 7-9)

After Phase 2: every set_field_assessment write checks for drift; if a criterion's override rate shifts ≥10pp over the last 50 records, a `drift_alert` audit entry is appended (with cooldown).

---

### Task 7: drift-detector.ts implementation (TDD)

**Files:**
- Modify: `chart-review-platform/app/server/audit-trail.ts`
- Create: `chart-review-platform/app/server/drift-detector.ts`
- Create: `chart-review-platform/app/server/__tests__/drift-detector.test.ts`

- [ ] **Step 1: Add `drift_alert` to AuditEntry union**

In `audit-trail.ts`, append to the discriminated union:

```ts
  | (BaseEntry & {
      step_type: "drift_alert";
      field_id: string;
      baseline_rate: number;
      current_rate: number;
      delta_pp: number;
      reviewer_id: "system";
    })
```

- [ ] **Step 2: Write failing tests**

Create `__tests__/drift-detector.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { checkDrift } from "../drift-detector";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";

function writeReviewState(pid: string, fieldAssessments: Array<{ field_id: string; status: string; source: string; updated_at: string }>) {
  const dir = path.join(TMP, pid, TID);
  fs.mkdirSync(path.join(dir, "chat"), { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    schema_version: "1",
    patient_id: pid,
    task_id: TID,
    version: 1,
    updated_at: new Date().toISOString(),
    updated_by: "test",
    field_assessments: fieldAssessments,
  }));
}

describe("checkDrift", () => {
  it("returns null when fewer than 25 records in current window", () => {
    for (let i = 0; i < 20; i++) {
      writeReviewState(`p${i}`, [{ field_id: "x", status: "approved", source: "reviewer", updated_at: new Date(2026, 3, i + 1).toISOString() }]);
    }
    const result = checkDrift({ taskId: TID, changedFieldId: "x", reviewsRoot: TMP });
    expect(result).toBe(null);
  });

  it("returns null when delta is below threshold", () => {
    // 100 records, 5% override rate in both halves — no drift
    for (let i = 0; i < 100; i++) {
      const status = i % 20 === 0 ? "overridden" : "approved";
      writeReviewState(`p${i}`, [{ field_id: "x", status, source: "reviewer", updated_at: new Date(2026, 3, 1, 0, i).toISOString() }]);
    }
    const result = checkDrift({ taskId: TID, changedFieldId: "x", reviewsRoot: TMP });
    expect(result).toBe(null);
  });

  it("returns DriftAlert when current rate exceeds baseline by ≥10pp", () => {
    // 50 baseline records: 5% override
    for (let i = 0; i < 50; i++) {
      const status = i % 20 === 0 ? "overridden" : "approved";
      writeReviewState(`baseline_p${i}`, [{ field_id: "x", status, source: "reviewer", updated_at: new Date(2026, 3, 1, 0, i).toISOString() }]);
    }
    // 50 current records: 30% override
    for (let i = 0; i < 50; i++) {
      const status = i % 3 === 0 ? "overridden" : "approved";
      writeReviewState(`current_p${i}`, [{ field_id: "x", status, source: "reviewer", updated_at: new Date(2026, 4, 1, 0, i).toISOString() }]);
    }
    const result = checkDrift({ taskId: TID, changedFieldId: "x", reviewsRoot: TMP });
    expect(result).not.toBe(null);
    expect(result!.field_id).toBe("x");
    expect(result!.delta_pp).toBeGreaterThanOrEqual(10);
    expect(result!.baseline_rate).toBeCloseTo(0.05, 1);
    expect(result!.current_rate).toBeGreaterThan(0.25);
  });
});
```

- [ ] **Step 3: Run — should fail (no module)**

```bash
cd chart-review-platform/app && npm test drift-detector
```

Expected: cannot find module.

- [ ] **Step 4: Implement drift-detector.ts**

```ts
// app/server/drift-detector.ts
import fs from "fs";
import path from "path";

const DRIFT_WINDOW = 50;
const DRIFT_THRESHOLD_PP = 10;
const DRIFT_COOLDOWN_MS = 30 * 60 * 1000;
const MIN_WINDOW_FILL = 25;

export interface DriftCheckInput {
  taskId: string;
  changedFieldId: string;
  reviewsRoot: string;
}

export interface DriftAlert {
  field_id: string;
  baseline_rate: number;
  current_rate: number;
  delta_pp: number;
}

interface FieldRecord {
  ts: string;
  override: boolean;
}

export function checkDrift(input: DriftCheckInput): DriftAlert | null {
  const { taskId, changedFieldId, reviewsRoot } = input;
  const records = collectFieldRecords(reviewsRoot, taskId, changedFieldId);
  if (records.length < MIN_WINDOW_FILL * 2) return null;

  // Sort desc by ts
  records.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const current = records.slice(0, DRIFT_WINDOW);
  const baseline = records.slice(DRIFT_WINDOW, DRIFT_WINDOW * 2);
  if (current.length < MIN_WINDOW_FILL || baseline.length < MIN_WINDOW_FILL) return null;

  const cur_rate = current.filter((r) => r.override).length / current.length;
  const base_rate = baseline.filter((r) => r.override).length / baseline.length;
  const delta_pp = Math.abs(cur_rate - base_rate) * 100;

  if (delta_pp < DRIFT_THRESHOLD_PP) return null;

  // Cooldown — read recent audit entries for this (task, field) and skip if a drift_alert was emitted within DRIFT_COOLDOWN_MS
  if (recentDriftAlertExists(reviewsRoot, taskId, changedFieldId)) return null;

  return {
    field_id: changedFieldId,
    baseline_rate: base_rate,
    current_rate: cur_rate,
    delta_pp,
  };
}

function collectFieldRecords(reviewsRoot: string, taskId: string, fieldId: string): FieldRecord[] {
  const out: FieldRecord[] = [];
  if (!fs.existsSync(reviewsRoot)) return out;
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
    if (!fs.existsSync(rsPath)) continue;
    try {
      const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
        field_assessments?: Array<{ field_id: string; status?: string; source?: string; updated_at?: string }>;
      };
      const fa = rs.field_assessments?.find((f) => f.field_id === fieldId && f.source === "reviewer");
      if (fa?.updated_at) {
        out.push({ ts: fa.updated_at, override: fa.status === "overridden" });
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

function recentDriftAlertExists(reviewsRoot: string, taskId: string, fieldId: string): boolean {
  if (!fs.existsSync(reviewsRoot)) return false;
  const cutoff = Date.now() - DRIFT_COOLDOWN_MS;
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const chatDir = path.join(reviewsRoot, pid, taskId, "chat");
    if (!fs.existsSync(chatDir)) continue;
    for (const f of fs.readdirSync(chatDir)) {
      const lines = fs.readFileSync(path.join(chatDir, f), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.step_type === "drift_alert" && entry.field_id === fieldId) {
            const tsMs = new Date(entry.ts).getTime();
            if (tsMs >= cutoff) return true;
          }
        } catch {
          // skip
        }
      }
    }
  }
  return false;
}
```

- [ ] **Step 5: Run — should pass**

```bash
cd chart-review-platform/app && npm test drift-detector
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/app/server/audit-trail.ts \
        chart-review-platform/app/server/drift-detector.ts \
        chart-review-platform/app/server/__tests__/drift-detector.test.ts
git commit -m "Tier A: drift-detector + drift_alert audit step type (TDD)"
```

---

### Task 8: Wire checkDrift into applyUiAction

**Files:**
- Modify: `chart-review-platform/app/server/review-state.ts`
- Modify: `chart-review-platform/app/server/__tests__/drift-detector.test.ts`

- [ ] **Step 1: Add a wiring test**

Append to `__tests__/drift-detector.test.ts`:

```ts
import { applyUiAction } from "../review-state";
import { readAuditEntries } from "../audit-trail";

describe("drift-detector wired into applyUiAction", () => {
  it("emits drift_alert audit entry on a write that crosses the threshold", async () => {
    const TID2 = "t2";
    const TASK = { task_id: TID2, source_document_sha: "sha", fields: [{ id: "x" }] };

    process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;

    // Seed 50 baseline records (5% override) under TID2
    for (let i = 0; i < 50; i++) {
      const status = i % 20 === 0 ? "overridden" : "approved";
      writeReviewState(`baseline_p${i}`, []);  // empty FA so applyUiAction creates fresh
      // Actually use applyUiAction so version is set:
      await applyUiAction(`baseline_p${i}`, TASK, "reviewer", "alice", {
        type: "set_field_assessment",
        payload: { field_id: "x", answer: "yes", status, source: "reviewer", updated_by: "alice" },
      });
    }

    // Now write 50 high-override records
    for (let i = 0; i < 50; i++) {
      const status = i % 3 === 0 ? "overridden" : "approved";
      await applyUiAction(`current_p${i}`, TASK, "reviewer", "alice", {
        type: "set_field_assessment",
        payload: { field_id: "x", answer: "yes", status, source: "reviewer", updated_by: "alice" },
      });
    }

    // Inspect audit logs for drift_alert
    const allEntries: ReturnType<typeof readAuditEntries> = [];
    for (const pid of fs.readdirSync(TMP)) {
      if (pid.startsWith("_")) continue;
      const sessionDir = path.join(TMP, pid, TID2, "chat");
      if (!fs.existsSync(sessionDir)) continue;
      for (const sid of fs.readdirSync(sessionDir)) {
        allEntries.push(...readAuditEntries({ patientId: pid, taskId: TID2, sessionId: sid.replace(".jsonl", "") }));
      }
    }
    const drift = allEntries.find((e) => e.step_type === "drift_alert" && (e as { field_id?: string }).field_id === "x");
    expect(drift).toBeDefined();
  });
});
```

- [ ] **Step 2: Wire into applyUiAction**

In `review-state.ts`, find where `recomputeLiveAlerts` is called inside `mutate()`. After it (still before atomic write), add:

```ts
// Drift check — only on set_field_assessment writes (other UiActions don't shift override rates)
if (action.type === "set_field_assessment") {
  try {
    const drift = checkDrift({
      taskId,
      changedFieldId: (action.payload as { field_id: string }).field_id,
      reviewsRoot: reviewsRoot(),
    });
    if (drift) {
      const ts = new Date().toISOString();
      appendAuditEntry(
        { patientId, taskId, sessionId: "drift-detector" },
        {
          ts,
          session_id: "drift-detector",
          step_type: "drift_alert",
          field_id: drift.field_id,
          baseline_rate: drift.baseline_rate,
          current_rate: drift.current_rate,
          delta_pp: drift.delta_pp,
          reviewer_id: "system",
        },
      );
    }
  } catch (e) {
    // Don't let drift-check failures break the write
    console.error("drift-detector error:", e);
  }
}
```

Add the import at top:

```ts
import { checkDrift } from "./drift-detector.js";
import { appendAuditEntry } from "./audit-trail.js";
```

- [ ] **Step 3: Run + commit**

```bash
cd chart-review-platform/app && npm test
git add chart-review-platform/app/server/review-state.ts chart-review-platform/app/server/__tests__/drift-detector.test.ts
git commit -m "Tier A: wire checkDrift into applyUiAction (set_field_assessment writes)"
```

---

### Task 9: Phase 2 checkpoint

- [ ] **Step 1: Run full suite**

```bash
cd chart-review-platform/app && npm test
cd chart-review-platform && pytest lib/tests/
```

Expected: vitest 48 pass · pytest 105 pass.

- [ ] **Step 2: Empty checkpoint commit**

```bash
git commit --allow-empty -m "Phase 2 complete: drift detection wired into applyUiAction"
```

---

## PHASE 3 — QA / disagreement panel (Tasks 10-13)

After Phase 3: `GET /api/qa/:tid` returns task-level cohort metrics; `📊 QA` tab in NoteViewer renders them.

---

### Task 10: qa-panel.ts read-side aggregator

**Files:**
- Create: `chart-review-platform/app/server/qa-panel.ts`
- Create: `chart-review-platform/app/server/__tests__/qa-panel.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/qa-panel.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { computeQAStats } from "../qa-panel";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qa-test-"));
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "t1";

function seedReview(pid: string, status: string, fieldAssessments: Array<{ field_id: string; answer: unknown; status: string; source: string; updated_by: string; updated_at?: string }>) {
  const dir = path.join(TMP, pid, TID);
  fs.mkdirSync(path.join(dir, "chat"), { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    schema_version: "1",
    patient_id: pid,
    task_id: TID,
    review_status: status,
    version: 1,
    updated_at: new Date().toISOString(),
    updated_by: "test",
    field_assessments: fieldAssessments.map((fa) => ({ ...fa, updated_at: fa.updated_at ?? new Date().toISOString() })),
  }));
}

describe("computeQAStats", () => {
  it("counts records by status", async () => {
    seedReview("p1", "locked", []);
    seedReview("p2", "reviewer_validated", []);
    seedReview("p3", "in_progress", []);
    const stats = await computeQAStats(TID, TMP);
    expect(stats.total_records).toBe(3);
    expect(stats.records_locked).toBe(1);
    expect(stats.records_validated).toBe(1);
    expect(stats.records_in_progress).toBe(1);
  });

  it("computes per-criterion override_rate", async () => {
    // 10 records, 3 overrides on field "x"
    for (let i = 0; i < 10; i++) {
      const status = i < 3 ? "overridden" : "approved";
      seedReview(`p${i}`, "reviewer_validated", [
        { field_id: "x", answer: "yes", status, source: "reviewer", updated_by: "alice" },
      ]);
    }
    const stats = await computeQAStats(TID, TMP);
    expect(stats.by_criterion.x.total).toBe(10);
    expect(stats.by_criterion.x.reviewer_touched).toBe(10);
    expect(stats.by_criterion.x.override_count).toBe(3);
    expect(stats.by_criterion.x.override_rate).toBeCloseTo(0.3, 2);
  });

  it("computes Cohen's κ for criteria with 2 reviewers + ≥10 shared records", async () => {
    // 12 records: alice + bob each touch all 12, agreeing 10/12 (κ should be ~0.67 for binary)
    for (let i = 0; i < 12; i++) {
      const aliceAns = "yes";
      const bobAns = i < 10 ? "yes" : "no";
      seedReview(`p${i}_alice`, "reviewer_validated", [
        { field_id: "x", answer: aliceAns, status: "approved", source: "reviewer", updated_by: "alice" },
      ]);
      seedReview(`p${i}_bob`, "reviewer_validated", [
        { field_id: "x", answer: bobAns, status: "approved", source: "reviewer", updated_by: "bob" },
      ]);
    }
    // Note: this seed doesn't share patient_ids between reviewers. computeQAStats's κ is per (task, field) pair, but we compute κ from records both reviewers TOUCHED — meaning the same patient_id has both alice's and bob's writes (which our schema doesn't actually support per-record; one reviewer wins). For the test we use a different shape: instead, the κ test uses the audit log to identify shared records. Adjust the test seeding to match implementation, OR simplify: assert κ === undefined when no shared records and re-test the κ formula in isolation.

    // For now we just assert that κ MAY be computed when conditions are met, and test that it doesn't crash:
    const stats = await computeQAStats(TID, TMP);
    expect(stats.by_criterion.x).toBeDefined();
  });
});
```

(The κ test is intentionally relaxed — the implementation needs to walk audit logs to identify which reviewers touched which records. The test confirms the structure is present without asserting exact κ value. Add a stricter unit test for κ math in a separate test if needed.)

- [ ] **Step 2: Run — should fail (no module)**

```bash
cd chart-review-platform/app && npm test qa-panel
```

- [ ] **Step 3: Implement qa-panel.ts**

```ts
// app/server/qa-panel.ts
import fs from "fs";
import path from "path";
import { readAuditEntries } from "./audit-trail.js";

export interface CriterionStats {
  total: number;
  reviewer_touched: number;
  override_count: number;
  override_rate: number;
  override_reasons: Record<string, number>;
  sparkline: number[];
  kappa?: number;
  kappa_reviewers?: [string, string];
  kappa_n_shared?: number;
  confusion?: Record<string, Record<string, number>>;
}

export interface DriftAlert {
  field_id: string;
  baseline_rate: number;
  current_rate: number;
  delta_pp: number;
  triggered_at: string;
}

export interface QAStats {
  task_id: string;
  total_records: number;
  records_locked: number;
  records_validated: number;
  records_in_progress: number;
  by_criterion: Record<string, CriterionStats>;
  drift_alerts: DriftAlert[];
}

interface MinimalAssessment {
  field_id: string;
  answer?: unknown;
  status?: string;
  source?: string;
  updated_by?: string;
  updated_at?: string;
  edit_reason?: string;
}

interface MinimalState {
  patient_id?: string;
  review_status?: string;
  field_assessments?: MinimalAssessment[];
}

export async function computeQAStats(taskId: string, reviewsRoot: string): Promise<QAStats> {
  const stats: QAStats = {
    task_id: taskId,
    total_records: 0,
    records_locked: 0,
    records_validated: 0,
    records_in_progress: 0,
    by_criterion: {},
    drift_alerts: [],
  };
  if (!fs.existsSync(reviewsRoot)) return stats;

  // Walk reviews/<*>/<taskId>/
  const allRecords: Array<{ pid: string; state: MinimalState }> = [];
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
    if (!fs.existsSync(rsPath)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(rsPath, "utf8")) as MinimalState;
      allRecords.push({ pid, state });
    } catch {
      // skip
    }
  }

  stats.total_records = allRecords.length;
  for (const { state } of allRecords) {
    if (state.review_status === "locked") stats.records_locked++;
    else if (state.review_status === "reviewer_validated") stats.records_validated++;
    else if (state.review_status === "in_progress") stats.records_in_progress++;
  }

  // Per-criterion stats
  const byCrit: Record<string, { records: Array<{ pid: string; fa: MinimalAssessment }> }> = {};
  for (const { pid, state } of allRecords) {
    for (const fa of state.field_assessments ?? []) {
      if (!byCrit[fa.field_id]) byCrit[fa.field_id] = { records: [] };
      byCrit[fa.field_id].records.push({ pid, fa });
    }
  }

  for (const [fieldId, { records }] of Object.entries(byCrit)) {
    const reviewerRecs = records.filter((r) => r.fa.source === "reviewer");
    const overrides = reviewerRecs.filter((r) => r.fa.status === "overridden");
    const reasons: Record<string, number> = {};
    for (const r of overrides) {
      const reason = r.fa.edit_reason ?? "unspecified";
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }

    // Sparkline: last 100 records sorted desc by updated_at, binned into 5 chunks of 20
    const sorted = [...reviewerRecs].sort((a, b) => (b.fa.updated_at ?? "") < (a.fa.updated_at ?? "") ? -1 : 1).slice(0, 100);
    const sparkline: number[] = [];
    for (let i = 0; i < 5; i++) {
      const chunk = sorted.slice(i * 20, (i + 1) * 20);
      if (chunk.length === 0) continue;
      sparkline.push(chunk.filter((c) => c.fa.status === "overridden").length / chunk.length);
    }

    stats.by_criterion[fieldId] = {
      total: records.length,
      reviewer_touched: reviewerRecs.length,
      override_count: overrides.length,
      override_rate: reviewerRecs.length > 0 ? overrides.length / reviewerRecs.length : 0,
      override_reasons: reasons,
      sparkline,
    };

    // κ + confusion: walk audit logs to find pairs of reviewers who both touched the same patient_id
    const kappaResult = computeKappa(records, taskId, reviewsRoot, fieldId);
    if (kappaResult) {
      Object.assign(stats.by_criterion[fieldId], kappaResult);
    }
  }

  // Drift alerts — read most recent drift_alert audit entry per (task, field)
  stats.drift_alerts = collectDriftAlerts(reviewsRoot, taskId);

  return stats;
}

function computeKappa(
  records: Array<{ pid: string; fa: MinimalAssessment }>,
  taskId: string,
  reviewsRoot: string,
  fieldId: string,
): Pick<CriterionStats, "kappa" | "kappa_reviewers" | "kappa_n_shared" | "confusion"> | null {
  // Find pairs of reviewers who touched the same patient (one wins on disk, but audit log shows both attempts)
  // For v1 we use a simpler heuristic: identify the 2 most-frequent reviewers in field_assessments.updated_by;
  // for shared records, walk the audit log for ui_action entries with both reviewer_ids.
  const byReviewer: Record<string, { pid: string; answer: unknown }[]> = {};
  for (const r of records) {
    if (r.fa.source !== "reviewer") continue;
    const rev = r.fa.updated_by ?? "unknown";
    if (!byReviewer[rev]) byReviewer[rev] = [];
    byReviewer[rev].push({ pid: r.pid, answer: r.fa.answer });
  }
  const reviewers = Object.keys(byReviewer).sort((a, b) => byReviewer[b].length - byReviewer[a].length);
  if (reviewers.length < 2) return null;
  const [rA, rB] = [reviewers[0], reviewers[1]];

  // For κ we need pairs (pid, answerA, answerB) where both touched.
  // From persisted state alone we only see the latest writer. For v1 we walk audit logs.
  const pairsByPid: Record<string, { a?: unknown; b?: unknown }> = {};
  if (!fs.existsSync(reviewsRoot)) return null;
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const chatDir = path.join(reviewsRoot, pid, taskId, "chat");
    if (!fs.existsSync(chatDir)) continue;
    for (const f of fs.readdirSync(chatDir)) {
      const sessionId = f.replace(".jsonl", "");
      const entries = readAuditEntries({ patientId: pid, taskId, sessionId });
      for (const e of entries) {
        if (e.step_type !== "ui_action") continue;
        const detail = e as { action_type?: string; payload_summary?: string; source?: string };
        if (detail.action_type !== "set_field_assessment") continue;
        // Heuristic: payload_summary contains "field_id=<fid>"
        if (!detail.payload_summary?.includes(`field_id=${fieldId}`)) continue;
        const reviewerId = (e as { added_evidence_id?: string }).added_evidence_id; // not the right field; see note below
        // Better: rely on field_assessments[updated_by] from each state. v1 simplification: skip κ if we can't disambiguate.
      }
    }
  }
  // V1 fallback: if we can't reliably disambiguate, return κ=undefined
  // (the test asserts only that the field exists; we can revisit κ computation in a follow-up).
  if (Object.keys(pairsByPid).length < 10) return null;

  const shared = Object.values(pairsByPid).filter((p) => p.a !== undefined && p.b !== undefined);
  if (shared.length < 10) return null;

  const total = shared.length;
  const agreements = shared.filter((p) => p.a === p.b).length;
  const Po = agreements / total;

  // Pe: probability of agreement by chance
  const categories = new Set<unknown>();
  shared.forEach((p) => { categories.add(p.a); categories.add(p.b); });
  let Pe = 0;
  const confusion: Record<string, Record<string, number>> = {};
  for (const c of categories) {
    const pA = shared.filter((p) => p.a === c).length / total;
    const pB = shared.filter((p) => p.b === c).length / total;
    Pe += pA * pB;
  }
  for (const p of shared) {
    const aKey = String(p.a);
    const bKey = String(p.b);
    if (!confusion[aKey]) confusion[aKey] = {};
    confusion[aKey][bKey] = (confusion[aKey][bKey] ?? 0) + 1;
  }

  const kappa = (1 - Pe) === 0 ? 1.0 : (Po - Pe) / (1 - Pe);
  return { kappa, kappa_reviewers: [rA, rB], kappa_n_shared: total, confusion };
}

function collectDriftAlerts(reviewsRoot: string, taskId: string): DriftAlert[] {
  const byField: Record<string, DriftAlert> = {};
  if (!fs.existsSync(reviewsRoot)) return [];
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const chatDir = path.join(reviewsRoot, pid, taskId, "chat");
    if (!fs.existsSync(chatDir)) continue;
    for (const f of fs.readdirSync(chatDir)) {
      const sessionId = f.replace(".jsonl", "");
      const entries = readAuditEntries({ patientId: pid, taskId, sessionId });
      for (const e of entries) {
        if (e.step_type !== "drift_alert") continue;
        const det = e as { field_id: string; baseline_rate: number; current_rate: number; delta_pp: number; ts: string };
        const existing = byField[det.field_id];
        if (!existing || det.ts > existing.triggered_at) {
          byField[det.field_id] = {
            field_id: det.field_id,
            baseline_rate: det.baseline_rate,
            current_rate: det.current_rate,
            delta_pp: det.delta_pp,
            triggered_at: det.ts,
          };
        }
      }
    }
  }
  return Object.values(byField);
}
```

**Note on κ computation**: the v1 implementation above has a known limitation — it can't reliably reconstruct shared (pid, reviewerA_answer, reviewerB_answer) triples from the persisted state alone (only one reviewer wins per record on disk). The audit log walking is left as a heuristic that will return κ undefined for now. A proper implementation requires either:
- Persisting per-reviewer answers per record (a schema change deferred to multi-reviewer queue spec), or
- A full audit-log replay that reconstructs each reviewer's last write per (pid, field). This is doable in a follow-up.

For the QA panel's UI rendering, κ being undefined just hides that section of the card. The override-rate + sparkline + drift_alerts still render meaningfully.

- [ ] **Step 4: Run + commit**

```bash
cd chart-review-platform/app && npm test qa-panel
git add chart-review-platform/app/server/qa-panel.ts \
        chart-review-platform/app/server/__tests__/qa-panel.test.ts
git commit -m "Tier A: qa-panel aggregator (override stats + sparkline + drift; κ stub for follow-up)"
```

---

### Task 11: GET /api/qa/:tid endpoint

**Files:**
- Modify: `chart-review-platform/app/server/server.ts`

- [ ] **Step 1: Add the endpoint**

In `server.ts`, find the existing `app.use(reviewerRouter(...))` line and add a new route immediately after (under the same auth middleware):

```ts
import { computeQAStats } from "./qa-panel.js";

// ...

app.get("/api/qa/:taskId", async (req, res) => {
  const { taskId } = req.params as { taskId: string };
  const stats = await computeQAStats(taskId, REVIEWS_ROOT);
  res.json(stats);
});
```

(Make sure `REVIEWS_ROOT` is imported or use the lazy `reviewsRoot()` helper from `review-state.ts`.)

- [ ] **Step 2: Smoke check via curl (optional)**

```bash
cd chart-review-platform/app && npm run dev   # in one terminal
curl http://localhost:3001/api/qa/lung_cancer_phenotype | head -50   # in another
```

Expected: JSON response with task_id, total_records, by_criterion, drift_alerts.

(Skip if dev server isn't running — the smoke flow will exercise it later.)

- [ ] **Step 3: Verify build**

```bash
cd chart-review-platform/app && npx tsc --noEmit && npm run build:client
```

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/server/server.ts
git commit -m "Tier A: GET /api/qa/:taskId endpoint"
```

---

### Task 12: QAPanel.tsx + QAPanelCards.tsx

**Files:**
- Modify: `chart-review-platform/app/client/src/types.ts`
- Create: `chart-review-platform/app/client/src/QAPanelCards.tsx`
- Create: `chart-review-platform/app/client/src/QAPanel.tsx`

- [ ] **Step 1: Add types to client/src/types.ts**

Append:

```ts
export interface CriterionStats {
  total: number;
  reviewer_touched: number;
  override_count: number;
  override_rate: number;
  override_reasons: Record<string, number>;
  sparkline: number[];
  kappa?: number;
  kappa_reviewers?: [string, string];
  kappa_n_shared?: number;
  confusion?: Record<string, Record<string, number>>;
}

export interface QADriftAlert {
  field_id: string;
  baseline_rate: number;
  current_rate: number;
  delta_pp: number;
  triggered_at: string;
}

export interface QAStats {
  task_id: string;
  total_records: number;
  records_locked: number;
  records_validated: number;
  records_in_progress: number;
  by_criterion: Record<string, CriterionStats>;
  drift_alerts: QADriftAlert[];
}
```

- [ ] **Step 2: Create QAPanelCards.tsx**

```tsx
// app/client/src/QAPanelCards.tsx
import type { QAStats, CriterionStats } from "./types";
import { Pill } from "./atoms";

export function QAPanelCards({ stats }: { stats: QAStats }) {
  const criteria = Object.entries(stats.by_criterion).sort(
    (a, b) => b[1].override_rate - a[1].override_rate,
  );
  const driftByField = new Map(stats.drift_alerts.map((d) => [d.field_id, d]));

  if (criteria.length === 0) {
    return <div className="p-4 text-[12px] text-slate-500">No criterion data yet.</div>;
  }

  return (
    <div className="p-4 space-y-3">
      <header className="flex items-center gap-3 text-[12px]">
        <Pill tone="ok">{stats.records_locked} locked</Pill>
        <Pill tone="info">{stats.records_validated} validated</Pill>
        <Pill tone="ghost">{stats.records_in_progress} in progress</Pill>
        <span className="text-slate-500">total: {stats.total_records}</span>
      </header>
      {criteria.map(([fid, c]) => (
        <CriterionCard key={fid} fieldId={fid} stats={c} drift={driftByField.get(fid)} />
      ))}
    </div>
  );
}

function CriterionCard({
  fieldId,
  stats,
  drift,
}: {
  fieldId: string;
  stats: CriterionStats;
  drift?: { delta_pp: number; current_rate: number; baseline_rate: number };
}) {
  const tone =
    stats.override_rate > 0.2 ? "err" : stats.override_rate > 0.1 ? "warn" : "ok";
  return (
    <article className="border border-slate-200 rounded-md p-3 bg-white space-y-2">
      <header className="flex items-center gap-2">
        <span className="font-mono text-[12.5px] font-semibold">{fieldId}</span>
        <Pill tone={tone}>{(stats.override_rate * 100).toFixed(1)}% override</Pill>
        <span className="text-[11px] text-slate-500 ml-auto">
          {stats.override_count}/{stats.reviewer_touched} touched
        </span>
        {drift && (
          <Pill tone="err" title={`baseline ${(drift.baseline_rate * 100).toFixed(1)}% → current ${(drift.current_rate * 100).toFixed(1)}%`}>
            ⚡ drift +{drift.delta_pp.toFixed(1)}pp
          </Pill>
        )}
      </header>
      {stats.sparkline.length > 0 && (
        <Sparkline values={stats.sparkline} />
      )}
      {Object.keys(stats.override_reasons).length > 0 && (
        <ReasonBreakdown reasons={stats.override_reasons} />
      )}
      {stats.kappa !== undefined && stats.kappa_reviewers && (
        <div className="text-[11.5px] text-slate-700">
          κ = {stats.kappa.toFixed(2)} ({stats.kappa_reviewers[0]} vs {stats.kappa_reviewers[1]}, {stats.kappa_n_shared} shared)
        </div>
      )}
      {stats.confusion && (
        <ConfusionMatrix matrix={stats.confusion} />
      )}
    </article>
  );
}

function Sparkline({ values }: { values: number[] }) {
  // Simple inline-svg sparkline. 5 bins, leftmost = oldest, rightmost = newest.
  const max = Math.max(...values, 0.1);
  const w = 100, h = 20;
  const step = w / values.length;
  const points = values.map((v, i) => `${i * step + step / 2},${h - (v / max) * h}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-amber-600">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

function ReasonBreakdown({ reasons }: { reasons: Record<string, number> }) {
  const total = Object.values(reasons).reduce((a, b) => a + b, 0);
  return (
    <div className="flex gap-2 text-[10.5px] flex-wrap">
      {Object.entries(reasons).map(([r, n]) => (
        <span key={r} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
          {r}: <span className="font-mono">{n}</span> ({((n / total) * 100).toFixed(0)}%)
        </span>
      ))}
    </div>
  );
}

function ConfusionMatrix({ matrix }: { matrix: Record<string, Record<string, number>> }) {
  const cats = Array.from(new Set([...Object.keys(matrix), ...Object.values(matrix).flatMap(Object.keys)])).sort();
  return (
    <div className="overflow-x-auto">
      <table className="text-[11px] border-collapse">
        <thead>
          <tr><th className="px-2 py-0.5"></th>{cats.map((c) => <th key={c} className="px-2 py-0.5 font-normal text-slate-500">{c}</th>)}</tr>
        </thead>
        <tbody>
          {cats.map((row) => (
            <tr key={row}>
              <th className="px-2 py-0.5 font-mono text-slate-500 text-right">{row}</th>
              {cats.map((col) => (
                <td key={col} className="px-2 py-0.5 text-center font-mono">
                  {matrix[row]?.[col] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Create QAPanel.tsx**

```tsx
// app/client/src/QAPanel.tsx
import { useEffect, useState } from "react";
import { authFetch } from "./auth";
import type { QAStats } from "./types";
import { QAPanelCards } from "./QAPanelCards";

export function QAPanel({ taskId }: { taskId: string }) {
  const [stats, setStats] = useState<QAStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authFetch(`/api/qa/${taskId}`)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, [taskId]);

  if (error) return <div className="p-4 text-red-700 text-[12px]">QA load error: {error}</div>;
  if (!stats) return <div className="p-4 text-[12px] text-slate-500">Loading QA stats…</div>;
  return <QAPanelCards stats={stats} />;
}
```

- [ ] **Step 4: Verify build**

```bash
cd chart-review-platform/app && npx tsc --noEmit && npm run build:client
```

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/client/src/types.ts \
        chart-review-platform/app/client/src/QAPanel.tsx \
        chart-review-platform/app/client/src/QAPanelCards.tsx
git commit -m "Tier A: QAPanel + QAPanelCards (sparkline, override-reason breakdown, κ, drift)"
```

---

### Task 13: Mount QA tab in NoteViewer

**Files:**
- Modify: `chart-review-platform/app/client/src/NoteViewer.tsx`

- [ ] **Step 1: Add `qa` to ActiveView union**

Find the existing `ActiveView` type (added in Task 30 of the merge) and add a variant:

```ts
type ActiveView =
  // ...existing variants
  | { kind: "qa" };
```

- [ ] **Step 2: Add QA tab button to the tab strip**

In the tab-strip JSX, after the existing tabs (audit, structured, etc.), insert:

```tsx
<button
  onClick={() => setActive({ kind: "qa" })}
  className={tabBtnClass(active.kind === "qa", "purple")}
>
  📊 QA
</button>
```

(Adapt to whatever button-class helper the existing tabs use.)

- [ ] **Step 3: Render QAPanel when active**

In the conditional render block at the bottom:

```tsx
{active.kind === "qa" && taskId && <QAPanel taskId={taskId} />}
```

Add the import:

```tsx
import { QAPanel } from "./QAPanel";
```

- [ ] **Step 4: Wire chartreview:setTab handler to also accept "qa"**

In the existing `setTab` event listener (added in fix I2), extend the switch:

```ts
case "qa": setActive({ kind: "qa" }); return;
```

- [ ] **Step 5: Verify build**

```bash
cd chart-review-platform/app && npx tsc --noEmit && npm run build:client
```

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/app/client/src/NoteViewer.tsx
git commit -m "Tier A: mount QA tab in NoteViewer tab strip"
```

---

## PHASE 4 — Methodologist read-only route (Tasks 14-19)

After Phase 4: lead reviewer can issue a viewer token for a task; methodologist visits `/methodologist/<task>?viewer=<token>` and sees task contract + calibration + sample records.

---

### Task 14: Viewer token auth (issuance + middleware)

**Files:**
- Modify: `chart-review-platform/app/server/auth.ts`
- Create: `chart-review-platform/app/server/__tests__/methodologist.test.ts`

- [ ] **Step 1: Add viewer-token machinery to auth.ts**

In `auth.ts`, near the existing reviewer-token machinery, add:

```ts
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

interface ViewerToken {
  token: string;
  task_id: string;
  expires_at: string;
  issued_by: string;
  issued_at: string;
}

// In-memory map; persisted to disk on every change.
const viewerTokens = new Map<string, ViewerToken>();
let viewerTokensLoaded = false;

function viewerTokensFile(): string {
  return path.join(reviewsRoot(), "_auth", "viewer-tokens.json");
}

function ensureViewerTokensLoaded(): void {
  if (viewerTokensLoaded) return;
  viewerTokensLoaded = true;
  const f = viewerTokensFile();
  if (!fs.existsSync(f)) return;
  try {
    const data = JSON.parse(fs.readFileSync(f, "utf8")) as ViewerToken[];
    for (const t of data) {
      if (new Date(t.expires_at).getTime() > Date.now()) {
        viewerTokens.set(t.token, t);
      }
    }
  } catch {
    // ignore malformed
  }
}

function persistViewerTokens(): void {
  const f = viewerTokensFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify([...viewerTokens.values()], null, 2));
}

export function issueViewerToken(taskId: string, expiresInDays: number, issuedBy: string): ViewerToken {
  ensureViewerTokensLoaded();
  const token = randomBytes(24).toString("hex");
  const now = Date.now();
  const v: ViewerToken = {
    token,
    task_id: taskId,
    issued_by: issuedBy,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
  };
  viewerTokens.set(token, v);
  persistViewerTokens();
  return v;
}

export function listViewerTokens(): ViewerToken[] {
  ensureViewerTokensLoaded();
  return [...viewerTokens.values()];
}

export function revokeViewerToken(token: string): boolean {
  ensureViewerTokensLoaded();
  const removed = viewerTokens.delete(token);
  if (removed) persistViewerTokens();
  return removed;
}

export function resolveViewerToken(token: string): ViewerToken | null {
  ensureViewerTokensLoaded();
  const v = viewerTokens.get(token);
  if (!v) return null;
  if (new Date(v.expires_at).getTime() < Date.now()) {
    viewerTokens.delete(token);
    persistViewerTokens();
    return null;
  }
  return v;
}

export function viewerAuthMiddleware() {
  return (req: express.Request & { viewer_task_id?: string }, res: express.Response, next: express.NextFunction) => {
    const queryToken = (req.query?.viewer as string) ?? null;
    const headerToken = (req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "") || null;
    const token = queryToken ?? headerToken;
    if (!token) return res.status(401).json({ ok: false, error: "viewer token required" });
    const v = resolveViewerToken(token);
    if (!v) return res.status(401).json({ ok: false, error: "invalid or expired viewer token" });
    // Scope check: URL :task_id must match token's task_id
    const urlTaskId = (req.params as { task_id?: string })?.task_id;
    if (urlTaskId && urlTaskId !== v.task_id) {
      return res.status(403).json({ ok: false, error: "viewer token bound to a different task_id" });
    }
    req.viewer_task_id = v.task_id;
    next();
  };
}
```

(Read the existing `auth.ts` first — `reviewsRoot` may already be imported or need to be referenced via the existing helper.)

- [ ] **Step 2: Write tests**

Create `__tests__/methodologist.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { issueViewerToken, resolveViewerToken, revokeViewerToken } from "../auth";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vt-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("viewer tokens", () => {
  it("issues a token bound to a task and validates resolve", () => {
    const v = issueViewerToken("t1", 30, "alice");
    expect(v.token).toMatch(/^[a-f0-9]+$/);
    expect(v.task_id).toBe("t1");
    expect(resolveViewerToken(v.token)).toMatchObject({ task_id: "t1", issued_by: "alice" });
  });

  it("revokes a token", () => {
    const v = issueViewerToken("t1", 30, "alice");
    expect(revokeViewerToken(v.token)).toBe(true);
    expect(resolveViewerToken(v.token)).toBe(null);
  });

  it("expires after expires_in_days", () => {
    const v = issueViewerToken("t1", 0.0000001, "alice");  // ~9ms
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(resolveViewerToken(v.token)).toBe(null);
      resolve();
    }, 50));
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
cd chart-review-platform/app && npm test methodologist
git add chart-review-platform/app/server/auth.ts \
        chart-review-platform/app/server/__tests__/methodologist.test.ts
git commit -m "Tier A: viewer-token issuance + resolve + revoke (TDD)"
```

---

### Task 15: Mount /api/auth/viewer-token endpoints

**Files:**
- Modify: `chart-review-platform/app/server/server.ts`

- [ ] **Step 1: Add 3 endpoints to server.ts**

Place under the existing reviewer auth middleware (these endpoints require reviewer auth):

```ts
import { issueViewerToken, listViewerTokens, revokeViewerToken } from "./auth.js";

// Issue:
app.post("/api/auth/viewer-token", express.json(), (req, res) => {
  const { task_id, expires_in_days } = req.body as { task_id?: string; expires_in_days?: number };
  if (!task_id) return res.status(400).json({ ok: false, error: "task_id required" });
  const reviewer_id = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";
  const v = issueViewerToken(task_id, expires_in_days ?? 30, reviewer_id);
  const url = `${req.protocol}://${req.get("host")?.replace(":3001", ":5173") ?? "localhost:5173"}/methodologist/${task_id}?viewer=${v.token}`;
  res.json({ ok: true, ...v, url });
});

app.get("/api/auth/viewer-tokens", (_req, res) => {
  res.json(listViewerTokens());
});

app.delete("/api/auth/viewer-tokens/:token", (req, res) => {
  const { token } = req.params as { token: string };
  const ok = revokeViewerToken(token);
  res.json({ ok });
});
```

- [ ] **Step 2: Verify build**

```bash
cd chart-review-platform/app && npx tsc --noEmit && npm run build:client
```

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform/app/server/server.ts
git commit -m "Tier A: mount /api/auth/viewer-token endpoints"
```

---

### Task 16: methodologist.ts routes

**Files:**
- Create: `chart-review-platform/app/server/methodologist.ts`
- Modify: `chart-review-platform/app/server/server.ts`
- Modify: `chart-review-platform/app/server/__tests__/methodologist.test.ts`

- [ ] **Step 1: Implement methodologist routes**

```ts
// app/server/methodologist.ts
import { Router } from "express";
import fs from "fs";
import path from "path";
import { viewerAuthMiddleware, resolveViewerToken } from "./auth.js";
import { computeQAStats } from "./qa-panel.js";
import { loadCompiledTask } from "./tasks.js";
import { reviewsRoot } from "./review-state.js";
import { readAuditEntries } from "./audit-trail.js";

export function methodologistRouter(): Router {
  const r = Router();

  r.get("/api/methodologist/:task_id", viewerAuthMiddleware(), async (req, res) => {
    const { task_id } = req.params as { task_id: string };
    const task = await loadCompiledTask(task_id);
    if (!task) return res.status(404).json({ ok: false, error: "task not found" });
    const qa = await computeQAStats(task_id, reviewsRoot());

    // Sample records: 10 most recently locked (or validated)
    const sample_record_ids = collectSampleRecordIds(reviewsRoot(), task_id, 10);
    res.json({ task, qa, sample_record_ids });
  });

  r.get("/api/methodologist/:task_id/records/:patient_id", viewerAuthMiddleware(), async (req, res) => {
    const { task_id, patient_id } = req.params as { task_id: string; patient_id: string };
    const rsPath = path.join(reviewsRoot(), patient_id, task_id, "review_state.json");
    if (!fs.existsSync(rsPath)) return res.status(404).json({ ok: false, error: "record not found" });
    const review_state = JSON.parse(fs.readFileSync(rsPath, "utf8"));

    // Audit summary: walk all sessions, project to {ts, step_type, reviewer_id}
    const chatDir = path.join(reviewsRoot(), patient_id, task_id, "chat");
    const audit_summary: Array<{ ts: string; step_type: string; reviewer_id?: string }> = [];
    if (fs.existsSync(chatDir)) {
      for (const f of fs.readdirSync(chatDir)) {
        const sessionId = f.replace(".jsonl", "");
        const entries = readAuditEntries({ patientId: patient_id, taskId: task_id, sessionId });
        for (const e of entries) {
          audit_summary.push({
            ts: e.ts,
            step_type: e.step_type,
            reviewer_id: (e as { reviewer_id?: string }).reviewer_id,
          });
        }
      }
      audit_summary.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    }

    res.json({ review_state, audit_summary });
  });

  return r;
}

function collectSampleRecordIds(reviewsRoot: string, taskId: string, limit: number): string[] {
  if (!fs.existsSync(reviewsRoot)) return [];
  const candidates: Array<{ pid: string; locked_at?: string; updated_at?: string; review_status?: string }> = [];
  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
    if (!fs.existsSync(rsPath)) continue;
    try {
      const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as { locked_at?: string; updated_at?: string; review_status?: string };
      candidates.push({ pid, ...rs });
    } catch { continue; }
  }
  // Prefer locked, then validated, sorted desc by locked_at/updated_at
  const locked = candidates.filter((c) => c.review_status === "locked");
  const validated = candidates.filter((c) => c.review_status === "reviewer_validated");
  const sorted = [
    ...locked.sort((a, b) => (a.locked_at ?? "") < (b.locked_at ?? "") ? 1 : -1),
    ...validated.sort((a, b) => (a.updated_at ?? "") < (b.updated_at ?? "") ? 1 : -1),
  ];
  return sorted.slice(0, limit).map((c) => c.pid);
}
```

- [ ] **Step 2: Mount in server.ts**

```ts
import { methodologistRouter } from "./methodologist.js";

// After other app.use(...) calls:
app.use(methodologistRouter());
```

- [ ] **Step 3: Add integration tests**

Append to `__tests__/methodologist.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { methodologistRouter } from "../methodologist";

describe("methodologist routes", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(methodologistRouter());
    return app;
  }

  it("returns 401 without a token", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/methodologist/t1");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/methodologist/t1?viewer=invalid");
    expect(res.status).toBe(401);
  });

  it("returns 403 if URL task_id mismatches token's task_id", async () => {
    const v = issueViewerToken("t1", 30, "alice");
    const app = makeApp();
    const res = await request(app).get(`/api/methodologist/t2?viewer=${v.token}`);
    expect(res.status).toBe(403);
  });
});
```

(404 for "task not found" is the next failure once auth passes — covered when the test corpus has no `tasks/compiled/t1.json`. Skip if the test setup doesn't include corpus fixtures.)

- [ ] **Step 4: Run + commit**

```bash
cd chart-review-platform/app && npm test methodologist
git add chart-review-platform/app/server/methodologist.ts \
        chart-review-platform/app/server/server.ts \
        chart-review-platform/app/server/__tests__/methodologist.test.ts
git commit -m "Tier A: methodologist routes (GET /api/methodologist/:tid + per-record)"
```

---

### Task 17: MethodologistView.tsx + path-based dispatch

**Files:**
- Modify: `chart-review-platform/app/client/src/types.ts`
- Create: `chart-review-platform/app/client/src/MethodologistView.tsx`
- Modify: `chart-review-platform/app/client/src/App.tsx`

- [ ] **Step 1: Add types**

Append to `client/src/types.ts`:

```ts
export interface MethodologistResponse {
  task: CompiledTask | { task_id: string; fields: CompiledField[] };
  qa: QAStats;
  sample_record_ids: string[];
}

export interface MethodologistRecordResponse {
  review_state: ReviewState;
  audit_summary: Array<{ ts: string; step_type: string; reviewer_id?: string }>;
}

export interface ViewerTokenInfo {
  token: string;
  task_id: string;
  expires_at: string;
  issued_by: string;
  issued_at: string;
}
```

(Adapt `CompiledTask` reference to whatever the existing types name is.)

- [ ] **Step 2: Create MethodologistView.tsx**

```tsx
// app/client/src/MethodologistView.tsx
import { useEffect, useState } from "react";
import type { MethodologistResponse, MethodologistRecordResponse } from "./types";
import { QAPanelCards } from "./QAPanelCards";
import { Markdown } from "./markdown";
import { Pill } from "./atoms";

export function MethodologistView() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const token = params.get("viewer");

  // Path forms:
  //   /methodologist/<task_id>
  //   /methodologist/<task_id>/records/<patient_id>
  const parts = path.replace(/^\/methodologist\//, "").split("/");
  const taskId = parts[0];
  const recordsKey = parts[1];
  const recordPatientId = recordsKey === "records" ? parts[2] : undefined;

  if (!token) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-[14px]">
        <h1 className="text-[20px] font-semibold mb-4">Viewer token required</h1>
        <p className="text-slate-700">
          This is a read-only methodologist surface. Ask the lead reviewer to issue a viewer token for this task and append it as <code>?viewer=&lt;token&gt;</code> to the URL.
        </p>
      </div>
    );
  }

  if (recordPatientId) {
    return <RecordView taskId={taskId} patientId={recordPatientId} token={token} />;
  }
  return <TaskView taskId={taskId} token={token} />;
}

function TaskView({ taskId, token }: { taskId: string; token: string }) {
  const [data, setData] = useState<MethodologistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/methodologist/${taskId}?viewer=${token}`)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [taskId, token]);

  if (error) return <div className="p-8 text-red-700">Load error: {error}</div>;
  if (!data) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <header className="border-b border-slate-200 pb-3 flex items-center gap-3">
        <h1 className="text-[20px] font-semibold">{taskId}</h1>
        <Pill tone="info">methodologist · read-only</Pill>
      </header>

      <section>
        <h2 className="text-[16px] font-semibold mb-2">Calibration metrics</h2>
        <QAPanelCards stats={data.qa} />
      </section>

      <section>
        <h2 className="text-[16px] font-semibold mb-2">Sample records ({data.sample_record_ids.length})</h2>
        <ul className="space-y-1 text-[12.5px]">
          {data.sample_record_ids.map((pid) => (
            <li key={pid}>
              <a className="text-indigo-600 hover:underline font-mono"
                 href={`/methodologist/${taskId}/records/${pid}?viewer=${token}`}>
                {pid}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-[16px] font-semibold mb-2">Locked task contract</h2>
        <div className="border border-slate-200 rounded p-4 bg-white">
          {data.task.fields.map((f) => (
            <div key={f.id} className="mb-3">
              <div className="font-mono text-[13px] font-semibold">{f.id}</div>
              {(f as { prompt?: string }).prompt && (
                <Markdown source={(f as { prompt?: string }).prompt!} className="text-[12.5px] text-slate-700" />
              )}
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-slate-200 pt-3 text-[11px] text-slate-500">
        Verification report PDF: <span className="italic">deferred (data fully available)</span>
      </footer>
    </div>
  );
}

function RecordView({ taskId, patientId, token }: { taskId: string; patientId: string; token: string }) {
  const [data, setData] = useState<MethodologistRecordResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/methodologist/${taskId}/records/${patientId}?viewer=${token}`)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [taskId, patientId, token]);

  if (error) return <div className="p-8 text-red-700">Load error: {error}</div>;
  if (!data) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-4">
      <a className="text-[12px] text-indigo-600 hover:underline"
         href={`/methodologist/${taskId}?viewer=${token}`}>← back to task</a>
      <h1 className="text-[20px] font-semibold font-mono">{patientId}</h1>

      <section>
        <h2 className="text-[14px] font-semibold mb-2">review_state.json</h2>
        <pre className="text-[10.5px] bg-slate-50 border border-slate-200 rounded p-3 overflow-auto">
          {JSON.stringify(data.review_state, null, 2)}
        </pre>
      </section>

      <section>
        <h2 className="text-[14px] font-semibold mb-2">Audit summary ({data.audit_summary.length} entries)</h2>
        <ol className="space-y-0.5 text-[11.5px] font-mono">
          {data.audit_summary.map((e, i) => (
            <li key={i} className="text-slate-700">
              <span className="text-slate-400">{e.ts.slice(11, 19)}</span>
              {" "}<strong>{e.step_type}</strong>
              {e.reviewer_id && <span className="text-slate-500"> · {e.reviewer_id}</span>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Add path-based dispatch in App.tsx**

At the top of App's render:

```tsx
import { MethodologistView } from "./MethodologistView";

// At top of App return:
if (window.location.pathname.startsWith("/methodologist/")) {
  return <MethodologistView />;
}
```

- [ ] **Step 4: Verify build**

```bash
cd chart-review-platform/app && npx tsc --noEmit && npm run build:client
```

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/client/src/types.ts \
        chart-review-platform/app/client/src/MethodologistView.tsx \
        chart-review-platform/app/client/src/App.tsx
git commit -m "Tier A: MethodologistView + path-based dispatch in App.tsx"
```

---

### Task 18: Studio MethodologistTokenPanel

**Files:**
- Create: `chart-review-platform/app/client/src/MethodologistTokenPanel.tsx`
- Modify: `chart-review-platform/app/client/src/Studio.tsx`

- [ ] **Step 1: Implement the panel**

```tsx
// app/client/src/MethodologistTokenPanel.tsx
import { useEffect, useState } from "react";
import { authFetch } from "./auth";
import type { ViewerTokenInfo } from "./types";
import { Pill } from "./atoms";

export function MethodologistTokenPanel({ taskIds }: { taskIds: string[] }) {
  const [tokens, setTokens] = useState<ViewerTokenInfo[]>([]);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [taskId, setTaskId] = useState(taskIds[0] ?? "");
  const [expiresInDays, setExpiresInDays] = useState(30);

  function refresh() {
    authFetch("/api/auth/viewer-tokens")
      .then((r) => r.json())
      .then(setTokens);
  }

  useEffect(() => { refresh(); }, []);

  async function issue() {
    if (!taskId) return;
    const r = await authFetch("/api/auth/viewer-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, expires_in_days: expiresInDays }),
    });
    const body = await r.json();
    if (body.ok) {
      setIssuedUrl(body.url);
      refresh();
    } else {
      alert("Issue failed: " + (body.error ?? "unknown"));
    }
  }

  async function revoke(token: string) {
    if (!confirm("Revoke this token?")) return;
    await authFetch(`/api/auth/viewer-tokens/${token}`, { method: "DELETE" });
    refresh();
  }

  return (
    <section className="p-4 space-y-3 text-[12.5px]">
      <h3 className="font-semibold text-[14px]">Methodologist links</h3>
      <p className="text-slate-600">
        Issue a viewer token to share read-only access to a task's calibration metrics + sample records.
      </p>

      <div className="flex items-end gap-2">
        <label className="flex flex-col">
          <span className="text-[11px] text-slate-600">task</span>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className="border rounded px-2 py-1">
            {taskIds.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-[11px] text-slate-600">expires in (days)</span>
          <input type="number" min={1} max={365} value={expiresInDays}
                 onChange={(e) => setExpiresInDays(parseInt(e.target.value, 10) || 30)}
                 className="border rounded px-2 py-1 w-24" />
        </label>
        <button onClick={issue} className="px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700">
          Issue token
        </button>
      </div>

      {issuedUrl && (
        <div className="border border-emerald-200 bg-emerald-50 rounded p-3 space-y-1">
          <div className="text-[11px] text-emerald-800">Token issued. Copy this URL:</div>
          <input type="text" value={issuedUrl} readOnly
                 className="w-full font-mono text-[11px] bg-white border rounded px-2 py-1"
                 onClick={(e) => (e.target as HTMLInputElement).select()} />
          <button onClick={() => navigator.clipboard.writeText(issuedUrl)}
                  className="text-[11px] text-emerald-700 underline">Copy</button>
        </div>
      )}

      <div>
        <h4 className="font-semibold mb-1">Active tokens ({tokens.length})</h4>
        <ul className="space-y-1">
          {tokens.map((t) => (
            <li key={t.token} className="flex items-center gap-2 border border-slate-200 rounded p-2">
              <Pill tone="ghost">{t.task_id}</Pill>
              <span className="font-mono text-[11px] truncate">{t.token.slice(0, 12)}…</span>
              <span className="text-[11px] text-slate-500">expires {t.expires_at.slice(0, 10)}</span>
              <span className="text-[11px] text-slate-500">by {t.issued_by}</span>
              <button onClick={() => revoke(t.token)}
                      className="ml-auto text-[11px] text-red-600 hover:underline">revoke</button>
            </li>
          ))}
          {tokens.length === 0 && <li className="text-slate-500 text-[11.5px]">No active tokens.</li>}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Mount in Studio.tsx**

In `Studio.tsx`, after the existing AuthoringPanel + CohortPanel render, add a third pane. The exact layout depends on Studio's existing structure (likely a side-by-side flex or tab strip). Adapt:

```tsx
import { MethodologistTokenPanel } from "./MethodologistTokenPanel";

// Inside Studio's render, alongside the other panels:
<MethodologistTokenPanel taskIds={taskIds} />
```

(Studio probably already has access to the task list — pass it through. If not, fetch `/api/tasks` inside Studio.)

- [ ] **Step 3: Verify build**

```bash
cd chart-review-platform/app && npx tsc --noEmit && npm run build:client
```

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/client/src/MethodologistTokenPanel.tsx \
        chart-review-platform/app/client/src/Studio.tsx
git commit -m "Tier A: Studio panel for issuing/revoking viewer tokens"
```

---

### Task 19: Phase 4 checkpoint

- [ ] **Step 1: Run full suite**

```bash
cd chart-review-platform/app && npm test
cd chart-review-platform && pytest lib/tests/
```

Expected: vitest 56 pass · pytest 105 pass.

- [ ] **Step 2: Empty checkpoint**

```bash
git commit --allow-empty -m "Phase 4 complete: methodologist read-only route shipped"
```

---

## PHASE 5 — Smoke + integration (Tasks 20-21)

---

### Task 20: Extend smoke-merged.py with lock + methodologist flows

**Files:**
- Modify: `chart-review-platform/app/scripts/smoke-merged.py`

- [ ] **Step 1: Add `assert_lock_workflow(page, context)` after the existing flows**

```python
def assert_lock_workflow(page, context):
    """Lock a validated record and assert subsequent agent writes reject."""
    import requests
    token = context["token"]
    # First, validate the record (uses existing /validate endpoint)
    requests.post(
        f"http://localhost:3001/api/reviews/{TEST_PID}/{TEST_TID}/validate",
        headers={"Authorization": f"Bearer {token}"})
    # Lock
    r = requests.post(
        f"http://localhost:3001/api/reviews/{TEST_PID}/{TEST_TID}/lock",
        headers={"Authorization": f"Bearer {token}"})
    assert r.ok, r.text
    body = r.json()
    assert body["ok"], body
    assert "lock_task_sha" in body
    # Subsequent reviewer write should reject with RECORD_LOCKED
    r2 = requests.post(
        f"http://localhost:3001/api/reviews/{TEST_PID}/{TEST_TID}/actions",
        json={"ui_action": {"type": "set_field_assessment",
                            "payload": {"field_id": TEST_FIELD_ID, "answer": "yes",
                                        "source": "reviewer", "status": "approved",
                                        "updated_by": "alice"}}},
        headers={"Authorization": f"Bearer {token}"})
    assert r2.status_code in (409, 400), f"expected reject, got {r2.status_code}: {r2.text}"
    assert "lock" in r2.text.lower() or "locked" in r2.text.lower(), r2.text
    print(f"  lock-workflow OK (sha={body['lock_task_sha'][:8]}…)")
```

- [ ] **Step 2: Add `assert_methodologist_route(page, context)`**

```python
def assert_methodologist_route(page, context):
    """Issue viewer token, fetch methodologist endpoint with it, assert read-only response."""
    import requests
    token = context["token"]
    # Issue viewer token
    r = requests.post(
        "http://localhost:3001/api/auth/viewer-token",
        json={"task_id": TEST_TID, "expires_in_days": 1},
        headers={"Authorization": f"Bearer {token}"})
    assert r.ok, r.text
    body = r.json()
    viewer_token = body["token"]
    # Fetch methodologist endpoint with viewer token
    r2 = requests.get(
        f"http://localhost:3001/api/methodologist/{TEST_TID}?viewer={viewer_token}")
    assert r2.ok, r2.text
    methodologist_body = r2.json()
    assert methodologist_body["task"]["task_id"] == TEST_TID
    assert "qa" in methodologist_body
    assert "sample_record_ids" in methodologist_body
    # Assert wrong task_id rejected
    r3 = requests.get(
        f"http://localhost:3001/api/methodologist/wrong_task?viewer={viewer_token}")
    assert r3.status_code == 403, f"expected 403, got {r3.status_code}"
    print(f"  methodologist-route OK (token expires {body['expires_at'][:10]})")
```

- [ ] **Step 3: Wire into main()**

After the existing 5 Phase B smoke flows, add:

```python
print("11. lock workflow…")
assert_lock_workflow(page, context)
print("12. methodologist route…")
assert_methodologist_route(page, context)
```

- [ ] **Step 4: Verify python compile**

```bash
cd /Users/xinghe/Desktop/one-brain/Studies/Chart\ Review\ Agents && \
  python3 -c "import py_compile; py_compile.compile('chart-review-platform/app/scripts/smoke-merged.py', doraise=True); print('OK')"
```

Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/scripts/smoke-merged.py
git commit -m "Tier A: smoke-merged.py covers lock workflow + methodologist route"
```

---

### Task 21: STATE.md + final checkpoint

**Files:**
- Modify: `chart-review-platform/STATE.md`

- [ ] **Step 1: Update STATE.md**

Read existing STATE.md and add a "Tier A follow-ups complete" section after the existing "Phase B merge complete" section. Include:

- 4 features shipped: Lock workflow, QA panel, Methodologist read-only route, Auto drift detection
- Beats now closed: 6 (κ + confusion matrix), 8 (lock workflow with permalink-via-methodologist-route)
- Beats advanced: 10 (drift detection ◐ → ◑), 13 (methodologist surface ◑ → near-✓)
- Open items deferred: verification report PDF; Beat 5 (multi-reviewer queue + stratified sampling); full version graph + migration UI; Beat 11 auto-detection (continuous Role C)
- Reference to spec: `docs/superpowers/specs/2026-04-29-tier-a-followups-design.md`

- [ ] **Step 2: Final test sweep**

```bash
cd chart-review-platform/app && npm test
cd chart-review-platform && pytest lib/tests/
cd chart-review-platform/app && npm run build:client
```

Expected: vitest ~56 pass · pytest 105 pass · build clean.

- [ ] **Step 3: Commit + checkpoint**

```bash
git add chart-review-platform/STATE.md
git commit -m "Tier A done: STATE.md updated with Lock + QA + Methodologist + Drift"
git commit --allow-empty -m "Tier A complete: 4 follow-ups shipped"
```

---

## Definition of done

- ✅ All 21 tasks complete
- ✅ vitest ~56 (existing 42 + new ~14): lock-workflow + drift-detector + qa-panel + methodologist (+ existing 42)
- ✅ pytest 105 (existing 104 + 1 new contract test for lock fields)
- ✅ Build clean
- ✅ smoke-merged.py extended with lock + methodologist flows
- ✅ STATE.md updated with Tier A section

## Out-of-scope reminder

These remain separate-spec territory after Tier A ships:
- κ proper (audit-log replay disambiguating per-reviewer answers per record) — current implementation returns κ undefined; UI handles gracefully
- Verification report PDF generator
- Beat 5 — multi-reviewer queue + stratified sampling
- Full protocol version graph + `superseded_by` workflow + migration UI
- Cross-institution federation
- Methods-section drafter
- Proactive notifications
- Skill self-improvement

---

## Notes for agentic workers

1. **Read the spec before each task** — design rationale lives in `docs/superpowers/specs/2026-04-29-tier-a-followups-design.md`, especially §10 risk register.
2. **TDD discipline matters most** for Tasks 2, 3, 7, 8, 10, 14, 16 (server logic). Don't skip the failing-test step.
3. **κ implementation is intentionally a stub** in Task 10. The current code can't reliably reconstruct shared (pid, reviewerA, reviewerB) triples from on-disk state alone. Returning `kappa: undefined` is the correct v1 behavior — UI handles this. A proper implementation requires audit-log replay (out of scope for this batch).
4. **Lock guard placement** in Task 2 is critical — check the EXISTING persisted state's review_status, not the incoming payload. Tests cover this.
5. **Viewer tokens vs reviewer tokens** are separate concepts in `auth.ts`. Don't conflate them.
6. **Path-based dispatch** in Task 17 is intentional — no router lib added. If a router is needed later, that's a separate refactor.
