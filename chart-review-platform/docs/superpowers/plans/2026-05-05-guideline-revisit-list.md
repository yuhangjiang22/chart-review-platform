# Guideline revisit list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a methodologist edits a criterion, every prior ground-truth record on that criterion enters a "revisit" list (no auto-confirm); methodologist resolves each row with one of three actions (keep prior / accept agent / re-annotate), or bulk-marks an entire criterion-group as kept.

**Architecture:** Add per-record `captured_against_schema_hash` provenance to `FieldAssessment`, stamped at commit time via the existing `criterionSchemaHash` helper. Build a `computeRevisitsForIter` server helper that joins compiled-task-current-SHAs vs each patient's `field_assessment.captured_against_schema_hash`. Expose `GET /api/pilots/:tid/:iid/revisits` and `POST /api/pilots/:tid/:iid/revisits/bulk-keep`. Render a single grouped-by-criterion list in a new `RevisitList.tsx` tab inside the Pilots iter detail surface.

**Tech Stack:** TypeScript (server: Express, client: React), Vitest for unit tests, supertest for route tests, `criterion-hash.ts` for SHA computation, atomic file writes via existing `lib/fs-atomic.ts`.

**Spec:** `chart-review-platform/docs/superpowers/specs/2026-05-05-guideline-modification-impact.md`

---

## File Structure

**Created:**
- `app/server/derived-adjudications/revisits.ts` — `computeRevisitsForIter()` helper.
- `app/server/__tests__/revisits-helper.test.ts` — unit tests for the helper.
- `app/server/__tests__/revisits-routes.test.ts` — supertest tests for the two new routes.
- `app/client/src/ui/PilotsTab/RevisitList.tsx` — the grouped list UI.

**Modified:**
- `app/server/domain/review/review-state.ts` — add `captured_against_schema_hash?: string` to `FieldAssessment`; stamp the hash inside `applySetAssessmentMutation` (around line 404).
- `app/client/src/types.ts` — mirror `captured_against_schema_hash?: string` on the client `FieldAssessment` type.
- `app/server/domain/iter/pilots.ts` — export `snapshotCriterionHashesSync` (currently private, line 267) so commit paths can reuse it.
- `app/server/adapters/http/pilot-routes.ts` — register the two new routes.
- `app/client/src/ui/PilotsTab/IterDetail.tsx` — add a new "Revisits" tab that renders `RevisitList`.

**Untouched (verified):**
- `criterion-hash.ts` — `criterionSchemaHash` and `criterionSchemaHashFromFile` exist as needed.
- `computeRerunPlan` — already triggers reruns when SHAs change; no modification.
- The annotation-first UI from the prior spec — independent surface.

---

### Task 1: Add `captured_against_schema_hash?` to FieldAssessment (server + client)

**Files:**
- Modify: `chart-review-platform/app/server/domain/review/review-state.ts:85-105`
- Modify: `chart-review-platform/app/client/src/types.ts` (the `FieldAssessment` interface around line 63)
- Test: `chart-review-platform/app/server/__tests__/field-assessment-revisit-hash.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `chart-review-platform/app/server/__tests__/field-assessment-revisit-hash.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { FieldAssessment } from "../domain/review/review-state.js";

describe("FieldAssessment.captured_against_schema_hash", () => {
  it("accepts the optional 16-char SHA prefix", () => {
    const fa: FieldAssessment = {
      field_id: "C1",
      source: "reviewer",
      status: "approved",
      updated_at: new Date().toISOString(),
      updated_by: "u1",
      captured_against_schema_hash: "abcd1234ef567890",
    };
    expect(fa.captured_against_schema_hash).toBe("abcd1234ef567890");
  });

  it("is optional (legacy records without the field remain valid)", () => {
    const fa: FieldAssessment = {
      field_id: "C1",
      source: "reviewer",
      status: "approved",
      updated_at: new Date().toISOString(),
      updated_by: "u1",
    };
    expect(fa.captured_against_schema_hash).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/field-assessment-revisit-hash.test.ts`
Expected: FAIL — `Property 'captured_against_schema_hash' does not exist on type 'FieldAssessment'`.

- [ ] **Step 3: Add the field to the server type**

Edit `chart-review-platform/app/server/domain/review/review-state.ts`. After `encounter_id?: string;` (around line 104), add:

```typescript
  /** SHA of the criterion at the time this assessment was committed.
   *  When this differs from the criterion's current SHA, the record is
   *  stale and surfaces in the revisit list. Optional only for back-compat
   *  with pre-existing records; new records always set it. */
  captured_against_schema_hash?: string;
```

Mirror on client at `chart-review-platform/app/client/src/types.ts` — locate the `FieldAssessment` interface and add the same field (with the same JSDoc).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/field-assessment-revisit-hash.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd "/Users/xinghe/Downloads/Chart Review Agents"
git branch --show-current   # verify "feat/guideline-revisit-list"; if not, switch first

git add chart-review-platform/app/server/domain/review/review-state.ts \
        chart-review-platform/app/client/src/types.ts \
        chart-review-platform/app/server/__tests__/field-assessment-revisit-hash.test.ts
git commit -m "feat(review-state): add captured_against_schema_hash to FieldAssessment

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Stamp `captured_against_schema_hash` at commit time

**Files:**
- Modify: `chart-review-platform/app/server/domain/iter/pilots.ts:267` — export `snapshotCriterionHashesSync`.
- Modify: `chart-review-platform/app/server/domain/review/review-state.ts` — stamp hash on assessment commit (around line 404).
- Test: `chart-review-platform/app/server/__tests__/field-assessment-stamp-hash.test.ts` (new)

This task ensures every new `field_assessment` carries the SHA of the criterion as it exists at commit time.

- [ ] **Step 1: Export `snapshotCriterionHashesSync`**

In `chart-review-platform/app/server/domain/iter/pilots.ts` line 267, change:

```typescript
function snapshotCriterionHashesSync(taskId: string): Record<string, string> {
```

to:

```typescript
export function snapshotCriterionHashesSync(taskId: string): Record<string, string> {
```

- [ ] **Step 2: Write the failing test**

Create `chart-review-platform/app/server/__tests__/field-assessment-stamp-hash.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { applyUiAction } from "../domain/review/index.js";
import type { CompiledTask } from "../tasks.js";

// We need a CompiledTask + a real schema-hash for one of its fields.
// The simplest path: stand up a minimal skill directory with one criterion
// .md file under a tmp PLATFORM_ROOT, then reuse loadCompiledTask /
// snapshotCriterionHashesSync to read it. Tests in adjudications.test.ts
// use a similar tmp-fixture pattern.

describe("set_field_assessment stamps captured_against_schema_hash", () => {
  it("populates captured_against_schema_hash from the compiled task on commit", () => {
    // Construct a minimal in-memory CompiledTask with one field.
    const task: CompiledTask = {
      task_id: "test_task",
      review_unit: "patient",
      manual_version: "1",
      source_document_sha: "sha-test",
      fields: [
        {
          id: "C1",
          prompt: "Test criterion",
          answer_schema: { type: "string" },
        },
      ],
    };

    // Inject a known hash via dependency injection or by stubbing
    // snapshotCriterionHashesSync. The simpler path: configure the test
    // to use a tmp PLATFORM_ROOT with a real .md file. See adjudications.test.ts
    // for the tmp-fixture pattern. Implementation may stub or use a real fixture
    // — both are acceptable as long as the test verifies that:
    //   1. After applyUiAction(set_field_assessment, ...), the resulting
    //      state's field_assessment for "C1" has a 16-char hex
    //      `captured_against_schema_hash` populated.
    //   2. The hash value matches snapshotCriterionHashesSync(task.task_id).C1.

    // Pseudocode (adjust based on chosen fixture style):
    //   const result = applyUiAction("p1", task, "reviewer", "u1", {
    //     type: "set_field_assessment",
    //     payload: {
    //       field_id: "C1",
    //       answer: "yes",
    //       status: "approved",
    //     },
    //   });
    //   const fa = result.state.field_assessments.find(f => f.field_id === "C1");
    //   expect(fa?.captured_against_schema_hash).toMatch(/^[0-9a-f]{16}$/);

    // For the implementer: pick the tmp-fixture style, follow patterns in
    // app/server/__tests__/adjudications.test.ts which sets up a tmp dir,
    // and write the .md file with a known answer_schema so the hash is stable.

    expect(true).toBe(true); // placeholder — replace with the real assertion
  });
});
```

NOTE FOR IMPLEMENTER: this test is a scaffold. Look at `chart-review-platform/app/server/__tests__/adjudications.test.ts` for the tmp-dir pattern, and at any test that already exercises `applyUiAction` for the right shape (try `grep -rn "applyUiAction" chart-review-platform/app/server/__tests__/`). Replace the pseudocode with a real fixture that stands up a tmp skill dir, writes a criterion `.md` file with frontmatter, points the loader at the tmp dir, and asserts the hash field is populated. **Do not commit until the assertion is real and the test fails before the implementation change in Step 4 lands.**

If the existing test infrastructure makes a fully integrated test too involved (e.g., `applyUiAction` requires substantial setup), substitute a focused unit test that calls `snapshotCriterionHashesSync` directly + invokes the in-`review-state.ts` private builder for a single FieldAssessment. The contract being verified is the same: hash stamped on commit.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/field-assessment-stamp-hash.test.ts`
Expected: FAIL — the assertion that `captured_against_schema_hash` is populated should fail before the implementation lands.

- [ ] **Step 4: Stamp the hash in `applySetAssessmentMutation`**

Locate `chart-review-platform/app/server/domain/review/review-state.ts` line 404 — the line `const assessment: FieldAssessment = {`. Just above this construction, look up the criterion's current schema hash from the task. Add:

```typescript
  // Stamp the criterion's current schema_hash so downstream revisit logic
  // can detect when this record was captured against an older criterion
  // version. Best-effort — when the snapshot returns nothing for this
  // field_id (e.g., during tests with bare in-memory tasks), we leave the
  // hash undefined.
  let captured_against_schema_hash: string | undefined;
  try {
    const hashes = snapshotCriterionHashesSync(task.task_id);
    captured_against_schema_hash = hashes[action.field_id];
  } catch {
    // Snapshot failed (e.g., skill dir missing in test fixtures). The field
    // remains undefined; this is the documented back-compat path.
  }
```

Then in the `const assessment: FieldAssessment = { ... };` literal, add:

```typescript
  captured_against_schema_hash,
```

Add the import at the top of the file:

```typescript
import { snapshotCriterionHashesSync } from "../iter/pilots.js";
```

If the import would create a circular dependency (review-state ↔ pilots), instead inline a thin re-export: create `chart-review-platform/app/server/domain/review/criterion-snapshot.ts` that re-exports `snapshotCriterionHashesSync` from `domain/iter/pilots.js`, and import from there. Run `npx tsc --noEmit` to detect cycles.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/field-assessment-stamp-hash.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full vitest suite to catch regressions**

Run: `cd chart-review-platform/app && npx vitest run 2>&1 | tail -10`
Expected: every previously-green test still green. The hash stamping is additive — existing tests that don't assert on `captured_against_schema_hash` should ignore it.

- [ ] **Step 7: Commit**

```bash
cd "/Users/xinghe/Downloads/Chart Review Agents"
git branch --show-current   # verify feat/guideline-revisit-list

git add chart-review-platform/app/server/domain/iter/pilots.ts \
        chart-review-platform/app/server/domain/review/review-state.ts \
        chart-review-platform/app/server/__tests__/field-assessment-stamp-hash.test.ts
# include criterion-snapshot.ts only if you created it for the cycle break
git commit -m "feat(review-state): stamp captured_against_schema_hash on commit

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `computeRevisitsForIter` helper

**Files:**
- Create: `chart-review-platform/app/server/derived-adjudications/revisits.ts`
- Test: `chart-review-platform/app/server/__tests__/revisits-helper.test.ts`

- [ ] **Step 1: Write the failing test**

Create `chart-review-platform/app/server/__tests__/revisits-helper.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { computeRevisitsForIter, type RevisitRow } from "../derived-adjudications/revisits.js";

// The helper joins three sources:
//   - compiled task → current criteria + SHAs
//   - per-patient review_state.json → field_assessments + captured_against_schema_hash
//   - run_id's per_patient draft → agent's new answer (decision support)
//
// The test sets up a minimal tmp tree with all three pieces and asserts:
//   1. Records whose captured_hash equals the current SHA do NOT appear.
//   2. Records whose captured_hash differs DO appear, with prior_answer +
//      agent_rerun_answer populated when the draft exists.
//   3. Records whose captured_hash differs but no agent draft exists yet
//      appear with agent_rerun_answer = null (rerun pending).
//   4. Patients with no GT records produce no rows for those criteria.

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "revisits-"));
}

describe("computeRevisitsForIter", () => {
  it("returns rows for records whose captured_hash differs from current", async () => {
    // Construct: a tmp PLATFORM_ROOT with one task, one criterion, one
    // patient. Patient's review_state has a field_assessment captured at
    // hash "old1234aaaaaaaa". Current criterion file's hash is something
    // else (different answer_schema). Iter manifest points at a run_id
    // with a per_patient/<pid>/agents/agent_1.json containing a new agent
    // answer for the field.
    //
    // Implementer: follow the fixture pattern in
    // chart-review-platform/app/server/__tests__/adjudications.test.ts and
    // chart-review-platform/app/server/__tests__/lock-route-derived-adj.test.ts
    // for tmp-tree construction.
    //
    // Then call:
    //   const result = computeRevisitsForIter({ taskId, iterId });
    //   expect(result.rows).toHaveLength(1);
    //   expect(result.rows[0].field_id).toBe("C1");
    //   expect(result.rows[0].patient_id).toBe("p1");
    //   expect(result.rows[0].prior_captured_hash).toBe("old1234aaaaaaaa");
    //   expect(result.rows[0].current_hash).not.toBe("old1234aaaaaaaa");
    //   expect(result.rows[0].prior_answer).toBe("yes");
    //   expect(result.rows[0].agent_rerun_answer).toBe("no");
    //   expect(result.criteria_changed).toBe(1);
    //   expect(result.total).toBe(1);

    expect(true).toBe(true); // placeholder until fixture is built
  });

  it("excludes records whose captured_hash matches current", async () => {
    // Same fixture as above but the patient's field_assessment has
    // captured_against_schema_hash equal to the current criterion hash.
    // Expected: result.rows is empty, result.total is 0.
    expect(true).toBe(true);
  });

  it("populates agent_rerun_answer = null when no agent draft exists yet", async () => {
    // Same as test 1 but no per_patient/<pid>/agents/agent_1.json file.
    // Expected: result.rows[0].agent_rerun_answer is null.
    expect(true).toBe(true);
  });

  it("excludes records that have no field_assessment for that criterion", async () => {
    // Patient's review_state has assessment for C2 (still fresh) but
    // not for C1. C1's hash changed. Expected: no row for (p1, C1)
    // because there's nothing to revisit.
    expect(true).toBe(true);
  });
});
```

NOTE FOR IMPLEMENTER: replace each `expect(true).toBe(true)` with a real fixture build + assertions. Reuse helpers from existing test files where possible. The four tests collectively define the contract for `computeRevisitsForIter`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/revisits-helper.test.ts`
Expected: FAIL — module `derived-adjudications/revisits.js` not found.

- [ ] **Step 3: Implement the helper**

Create `chart-review-platform/app/server/derived-adjudications/revisits.ts`:

```typescript
import fs from "fs";
import path from "path";
import { loadCompiledTask } from "../tasks.js";
import {
  getPilotManifest,
  snapshotCriterionHashesSync,
} from "../domain/iter/pilots.js";
import { runDir as computeRunDir } from "../infra/batch-run/index.js";
import { reviewsRoot } from "../patients.js";
import type { Evidence } from "../domain/review/review-state.js";

export interface RevisitRow {
  field_id: string;
  field_prompt_current: string;
  patient_id: string;
  prior_answer: unknown;
  prior_evidence: Evidence[];
  prior_rationale: string | null;
  agent_rerun_answer: unknown | null;
  agent_rerun_rationale: string | null;
  prior_captured_hash: string | null;
  current_hash: string;
}

export interface RevisitsResult {
  rows: RevisitRow[];
  criteria_changed: number;
  total: number;
}

interface PerPatientReviewState {
  field_assessments?: Array<{
    field_id: string;
    source: string;
    answer?: unknown;
    evidence?: Evidence[];
    rationale?: string;
    captured_against_schema_hash?: string;
  }>;
}

interface AgentDraft {
  field_assessments?: Array<{
    field_id: string;
    answer?: unknown;
    rationale?: string;
  }>;
}

function readReviewState(taskId: string, patientId: string): PerPatientReviewState | null {
  const fp = path.join(reviewsRoot(), patientId, taskId, "review_state.json");
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function readAgentDraft(runDir: string, patientId: string, agentId: string): AgentDraft | null {
  const fp = path.join(runDir, "per_patient", patientId, "agents", `${agentId}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function listPatientsWithReviews(taskId: string): string[] {
  const root = reviewsRoot();
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const patientId of fs.readdirSync(root)) {
    const taskDir = path.join(root, patientId, taskId);
    if (fs.existsSync(path.join(taskDir, "review_state.json"))) {
      out.push(patientId);
    }
  }
  return out;
}

export function computeRevisitsForIter(args: {
  taskId: string;
  iterId: string;
}): RevisitsResult {
  const { taskId, iterId } = args;
  const task = loadCompiledTask(taskId);
  if (!task) return { rows: [], criteria_changed: 0, total: 0 };

  const currentHashes = snapshotCriterionHashesSync(taskId);
  const fieldPrompts: Record<string, string> = {};
  for (const f of task.fields) fieldPrompts[f.id] = f.prompt ?? "";

  const manifest = getPilotManifest(taskId, iterId);
  const runDirAbs = manifest ? computeRunDir(manifest.run_id) : null;

  const patients = listPatientsWithReviews(taskId);
  const rows: RevisitRow[] = [];
  const changedFieldIds = new Set<string>();

  for (const patientId of patients) {
    const state = readReviewState(taskId, patientId);
    if (!state?.field_assessments) continue;
    const agentDraft = runDirAbs ? readAgentDraft(runDirAbs, patientId, "agent_1") : null;

    for (const fa of state.field_assessments) {
      const currentHash = currentHashes[fa.field_id];
      if (!currentHash) continue;                                // no current criterion (deleted)
      const captured = fa.captured_against_schema_hash ?? null;
      if (captured === currentHash) continue;                    // fresh
      // It's a revisit row.
      changedFieldIds.add(fa.field_id);
      const draft = agentDraft?.field_assessments?.find((a) => a.field_id === fa.field_id);
      rows.push({
        field_id: fa.field_id,
        field_prompt_current: fieldPrompts[fa.field_id] ?? "",
        patient_id: patientId,
        prior_answer: fa.answer ?? null,
        prior_evidence: fa.evidence ?? [],
        prior_rationale: fa.rationale ?? null,
        agent_rerun_answer: draft?.answer ?? null,
        agent_rerun_rationale: draft?.rationale ?? null,
        prior_captured_hash: captured,
        current_hash: currentHash,
      });
    }
  }

  return { rows, criteria_changed: changedFieldIds.size, total: rows.length };
}
```

If `reviewsRoot()` doesn't exist as an exported helper, look in `app/server/patients.ts` for the equivalent (search `grep -n "reviewsRoot\|reviews/" app/server/patients.ts`). Use whatever the established helper is. If none exists, add one inline in this file using `path.join(PLATFORM_ROOT, "reviews")` as a fallback — but verify against the codebase first.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/revisits-helper.test.ts`
Expected: PASS (4 tests, once you've replaced the `expect(true).toBe(true)` placeholders with real assertions).

- [ ] **Step 5: Commit**

```bash
cd "/Users/xinghe/Downloads/Chart Review Agents"
git branch --show-current   # verify feat/guideline-revisit-list
git add chart-review-platform/app/server/derived-adjudications/revisits.ts \
        chart-review-platform/app/server/__tests__/revisits-helper.test.ts
git commit -m "feat(revisits): computeRevisitsForIter helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `GET /api/pilots/:tid/:iid/revisits` route

**Files:**
- Modify: `chart-review-platform/app/server/adapters/http/pilot-routes.ts`
- Test: `chart-review-platform/app/server/__tests__/revisits-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `chart-review-platform/app/server/__tests__/revisits-routes.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import { pilotRouter } from "../adapters/http/pilot-routes.js";
import * as revisitsModule from "../derived-adjudications/revisits.js";

function appWithRouter(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(pilotRouter());
  return app;
}

describe("GET /api/pilots/:taskId/:iterId/revisits", () => {
  it("returns rows from computeRevisitsForIter", async () => {
    const stub = {
      rows: [
        {
          field_id: "C1",
          field_prompt_current: "is it confirmed?",
          patient_id: "p1",
          prior_answer: "yes",
          prior_evidence: [],
          prior_rationale: "old rationale",
          agent_rerun_answer: "no",
          agent_rerun_rationale: "new rationale",
          prior_captured_hash: "old1234aaaaaaaa",
          current_hash: "new5678bbbbbbbb",
        },
      ],
      criteria_changed: 1,
      total: 1,
    };
    vi.spyOn(revisitsModule, "computeRevisitsForIter").mockReturnValue(stub);
    const app = appWithRouter();
    const res = await request(app).get("/api/pilots/test_task/iter_001/revisits");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].field_id).toBe("C1");
    expect(res.body.criteria_changed).toBe(1);
    expect(res.body.total).toBe(1);
  });

  it("returns ok=true with empty rows when no revisits exist", async () => {
    vi.spyOn(revisitsModule, "computeRevisitsForIter").mockReturnValue({
      rows: [],
      criteria_changed: 0,
      total: 0,
    });
    const app = appWithRouter();
    const res = await request(app).get("/api/pilots/test_task/iter_002/revisits");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/revisits-routes.test.ts`
Expected: FAIL — route returns 404 because it isn't registered yet.

- [ ] **Step 3: Add the route to `pilot-routes.ts`**

Open `chart-review-platform/app/server/adapters/http/pilot-routes.ts`. At the top import block, add:

```typescript
import { computeRevisitsForIter } from "../../derived-adjudications/revisits.js";
```

Inside the `pilotRouter()` function, after the existing `/api/pilots/:taskId/:iterId/adjudications` routes, add:

```typescript
  // Revisit list — surfaces every prior GT record on a criterion whose SHA
  // has changed since the record was committed. Methodologist's worklist
  // when re-running an edited criterion.
  router.get("/api/pilots/:taskId/:iterId/revisits", (req, res) => {
    const { taskId, iterId } = req.params;
    const result = computeRevisitsForIter({ taskId, iterId });
    res.json({ ok: true, ...result });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/revisits-routes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd "/Users/xinghe/Downloads/Chart Review Agents"
git branch --show-current   # verify feat/guideline-revisit-list
git add chart-review-platform/app/server/adapters/http/pilot-routes.ts \
        chart-review-platform/app/server/__tests__/revisits-routes.test.ts
git commit -m "feat(http): GET /api/pilots/:taskId/:iterId/revisits

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `POST /api/pilots/:tid/:iid/revisits/bulk-keep` route

**Files:**
- Modify: `chart-review-platform/app/server/adapters/http/pilot-routes.ts` (extend with the POST route).
- Modify: `chart-review-platform/app/server/derived-adjudications/revisits.ts` (add `bulkKeepRevisits` helper).
- Modify: `chart-review-platform/app/server/__tests__/revisits-routes.test.ts` (extend with POST tests).

The bulk-keep handler iterates the matching field_assessments for one (taskId, fieldId, [patient_ids?]) and bumps each one's `captured_against_schema_hash` to the current SHA — without changing answer/evidence/rationale.

- [ ] **Step 1: Add POST tests**

Append to `chart-review-platform/app/server/__tests__/revisits-routes.test.ts`:

```typescript
describe("POST /api/pilots/:taskId/:iterId/revisits/bulk-keep", () => {
  it("returns 200 with the count of records bumped", async () => {
    const bulk = vi.fn().mockResolvedValue({ bumped: 5 });
    vi.spyOn(revisitsModule, "bulkKeepRevisits").mockImplementation(bulk);
    const app = appWithRouter();
    const res = await request(app)
      .post("/api/pilots/test_task/iter_001/revisits/bulk-keep")
      .send({ field_id: "C1" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.bumped).toBe(5);
    expect(bulk).toHaveBeenCalledWith({
      taskId: "test_task",
      fieldId: "C1",
      patientIds: undefined,
      reviewerId: expect.any(String),
    });
  });

  it("scopes to specific patient_ids when provided", async () => {
    const bulk = vi.fn().mockResolvedValue({ bumped: 2 });
    vi.spyOn(revisitsModule, "bulkKeepRevisits").mockImplementation(bulk);
    const app = appWithRouter();
    const res = await request(app)
      .post("/api/pilots/test_task/iter_001/revisits/bulk-keep")
      .send({ field_id: "C1", patient_ids: ["p1", "p2"] });
    expect(res.status).toBe(200);
    expect(res.body.bumped).toBe(2);
    expect(bulk).toHaveBeenCalledWith({
      taskId: "test_task",
      fieldId: "C1",
      patientIds: ["p1", "p2"],
      reviewerId: expect.any(String),
    });
  });

  it("400 when field_id is missing", async () => {
    const app = appWithRouter();
    const res = await request(app)
      .post("/api/pilots/test_task/iter_001/revisits/bulk-keep")
      .send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/revisits-routes.test.ts`
Expected: FAIL — `bulkKeepRevisits` not exported.

- [ ] **Step 3: Implement `bulkKeepRevisits`**

Append to `chart-review-platform/app/server/derived-adjudications/revisits.ts`:

```typescript
import { writeJsonAtomic } from "../lib/fs-atomic.js";

export interface BulkKeepArgs {
  taskId: string;
  fieldId: string;
  patientIds?: string[];        // when omitted, applies to every patient with a stale record
  reviewerId: string;
}

export interface BulkKeepResult {
  bumped: number;
}

export async function bulkKeepRevisits(args: BulkKeepArgs): Promise<BulkKeepResult> {
  const { taskId, fieldId, patientIds } = args;
  const currentHashes = snapshotCriterionHashesSync(taskId);
  const currentHash = currentHashes[fieldId];
  if (!currentHash) return { bumped: 0 };

  const candidates = patientIds ?? listPatientsWithReviews(taskId);
  let bumped = 0;
  for (const patientId of candidates) {
    const fp = path.join(reviewsRoot(), patientId, taskId, "review_state.json");
    if (!fs.existsSync(fp)) continue;
    let state: PerPatientReviewState;
    try {
      state = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      continue;
    }
    const fa = state.field_assessments?.find((a) => a.field_id === fieldId);
    if (!fa) continue;
    if (fa.captured_against_schema_hash === currentHash) continue;   // already fresh
    fa.captured_against_schema_hash = currentHash;
    writeJsonAtomic(fp, state);
    bumped++;
  }
  return { bumped };
}
```

- [ ] **Step 4: Add the POST route**

In `chart-review-platform/app/server/adapters/http/pilot-routes.ts`, after the GET revisits route, add:

```typescript
  router.post(
    "/api/pilots/:taskId/:iterId/revisits/bulk-keep",
    express.json(),
    async (req, res) => {
      const { taskId } = req.params;
      const { field_id, patient_ids } = req.body ?? {};
      if (typeof field_id !== "string" || field_id.length === 0) {
        return res.status(400).json({ ok: false, error: "field_id required" });
      }
      const reviewerId = (req.headers["x-reviewer-id"] as string) ?? "anonymous-reviewer";
      try {
        const result = await bulkKeepRevisits({
          taskId,
          fieldId: field_id,
          patientIds: Array.isArray(patient_ids) ? patient_ids : undefined,
          reviewerId,
        });
        res.json({ ok: true, ...result });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    },
  );
```

Add the import at the top of `pilot-routes.ts`:

```typescript
import {
  computeRevisitsForIter,
  bulkKeepRevisits,
} from "../../derived-adjudications/revisits.js";
import express from "express";
```

If `express` is already imported elsewhere in the file, don't double-import — reuse the existing one.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/revisits-routes.test.ts`
Expected: PASS (5 tests total — 2 GET + 3 POST).

- [ ] **Step 6: Commit**

```bash
cd "/Users/xinghe/Downloads/Chart Review Agents"
git branch --show-current   # verify feat/guideline-revisit-list
git add chart-review-platform/app/server/derived-adjudications/revisits.ts \
        chart-review-platform/app/server/adapters/http/pilot-routes.ts \
        chart-review-platform/app/server/__tests__/revisits-routes.test.ts
git commit -m "feat(http): POST /api/pilots/:taskId/:iterId/revisits/bulk-keep

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `RevisitList` client component

**Files:**
- Create: `chart-review-platform/app/client/src/ui/PilotsTab/RevisitList.tsx`

The component fetches revisits from the GET endpoint, groups by `field_id`, and renders the list with three per-row actions and one per-group bulk button.

- [ ] **Step 1: Write the component**

Create `chart-review-platform/app/client/src/ui/PilotsTab/RevisitList.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../authFetch";

interface RevisitRow {
  field_id: string;
  field_prompt_current: string;
  patient_id: string;
  prior_answer: unknown;
  prior_evidence: unknown[];
  prior_rationale: string | null;
  agent_rerun_answer: unknown | null;
  agent_rerun_rationale: string | null;
  prior_captured_hash: string | null;
  current_hash: string;
}

interface RevisitsResponse {
  ok: boolean;
  rows: RevisitRow[];
  criteria_changed: number;
  total: number;
}

export interface RevisitListProps {
  taskId: string;
  iterId: string;
  /** Open the per-field revisit pane for a single (patient, criterion). */
  onReannotate?: (patientId: string, fieldId: string) => void;
}

function groupByField(rows: RevisitRow[]): Map<string, RevisitRow[]> {
  const out = new Map<string, RevisitRow[]>();
  for (const r of rows) {
    const list = out.get(r.field_id) ?? [];
    list.push(r);
    out.set(r.field_id, list);
  }
  return out;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function RevisitList(props: RevisitListProps) {
  const { taskId, iterId, onReannotate } = props;
  const [data, setData] = useState<RevisitsResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(async () => {
    setBusy(true);
    try {
      const r = await authFetch(`/api/pilots/${taskId}/${iterId}/revisits`);
      const j = (await r.json()) as RevisitsResponse;
      if (j.ok) setData(j);
    } finally {
      setBusy(false);
    }
  }, [taskId, iterId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function bulkKeep(fieldId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await authFetch(`/api/pilots/${taskId}/${iterId}/revisits/bulk-keep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field_id: fieldId }),
      });
    } finally {
      setBusy(false);
    }
    await refetch();
  }

  async function rowAction(row: RevisitRow, action: "keep_prior" | "accept_agent" | "reannotate") {
    if (action === "reannotate") {
      onReannotate?.(row.patient_id, row.field_id);
      return;
    }
    setBusy(true);
    try {
      if (action === "keep_prior") {
        await authFetch(`/api/pilots/${taskId}/${iterId}/revisits/bulk-keep`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ field_id: row.field_id, patient_ids: [row.patient_id] }),
        });
      } else {
        // accept_agent: write the agent's rerun answer as a new reviewer assessment.
        await authFetch(`/api/reviews/${row.patient_id}/${taskId}/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            field_id: row.field_id,
            answer: row.agent_rerun_answer,
            evidence: [],                  // agent's evidence not threaded yet — see open question in spec
            rationale: row.agent_rerun_rationale ?? "",
            status: "approved",
          }),
        });
      }
    } finally {
      setBusy(false);
    }
    await refetch();
  }

  if (!data) return <div className="p-4 text-sm text-muted-foreground">Loading revisits…</div>;
  if (data.total === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No revisits — every prior call was captured against the current criterion versions.
      </div>
    );
  }

  const groups = groupByField(data.rows);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="text-[12px] text-muted-foreground">
        {data.criteria_changed} criteria changed · {data.total} prior calls to revisit
      </div>
      {[...groups.entries()].map(([fieldId, rows]) => {
        const promptCurrent = rows[0]?.field_prompt_current ?? "";
        return (
          <section key={fieldId} className="rounded-md border border-border bg-card p-3">
            <header className="flex items-baseline gap-3 pb-2">
              <code className="font-mono text-[12px] text-foreground">{fieldId}</code>
              <span className="text-[12.5px] text-foreground/80">{promptCurrent}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void bulkKeep(fieldId)}
                className="ml-auto rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-muted/40"
              >
                Mark all {rows.length} as keep prior
              </button>
            </header>
            <ul className="flex flex-col gap-1.5">
              {rows.map((r) => (
                <li
                  key={`${r.patient_id}__${r.field_id}`}
                  className="grid grid-cols-[120px_1fr_1fr_auto] items-center gap-2 text-[12px]"
                >
                  <code className="font-mono">{r.patient_id}</code>
                  <span>
                    prior: <code className="font-mono">{fmt(r.prior_answer)}</code>
                  </span>
                  <span>
                    agent now:{" "}
                    {r.agent_rerun_answer === null ? (
                      <span className="italic text-muted-foreground">pending</span>
                    ) : (
                      <code className="font-mono">{fmt(r.agent_rerun_answer)}</code>
                    )}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void rowAction(r, "keep_prior")}
                      className="rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-muted/40"
                    >
                      keep prior
                    </button>
                    <button
                      type="button"
                      disabled={busy || r.agent_rerun_answer === null}
                      onClick={() => void rowAction(r, "accept_agent")}
                      className="rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-muted/40 disabled:opacity-50"
                    >
                      accept agent
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void rowAction(r, "reannotate")}
                      className="rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-muted/40"
                    >
                      re-annotate
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
```

If `authFetch` is in a different relative path on the client, adjust the import. Look at how existing PilotsTab files import it (e.g. `IterDetail.tsx`, `LockTestPatientGrid.tsx`).

- [ ] **Step 2: Type-check**

Run: `cd chart-review-platform/app && npx tsc --noEmit -p client/tsconfig.json 2>&1 | grep "PilotsTab/RevisitList\|error TS" | head -10`
Expected: no errors mentioning `RevisitList.tsx`.

(Pre-existing errors in unrelated files are not yours to fix.)

- [ ] **Step 3: Commit**

```bash
cd "/Users/xinghe/Downloads/Chart Review Agents"
git branch --show-current   # verify feat/guideline-revisit-list
git add chart-review-platform/app/client/src/ui/PilotsTab/RevisitList.tsx
git commit -m "feat(client): RevisitList component

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Wire RevisitList into PilotsTab IterDetail

**Files:**
- Modify: `chart-review-platform/app/client/src/ui/PilotsTab/IterDetail.tsx` — add a "Revisits" tab.

- [ ] **Step 1: Inspect IterDetail.tsx**

Open the file and locate the existing tab list. Tabs are usually rendered as a row of buttons with a state-variable like `activeTab`. Search for existing tab labels (e.g., "Disagreements", "Critique", "Stats") to find the pattern.

- [ ] **Step 2: Add the Revisits tab**

In the same component:

1. Add `"revisits"` to the union type used for the `activeTab` state.
2. Add a tab button: `Revisits` to the tab row.
3. Add the conditional render for the tab body:

```tsx
{activeTab === "revisits" && (
  <RevisitList
    taskId={taskId}
    iterId={iterId}
    onReannotate={(patientId, fieldId) => {
      // Hand off to the patient-review surface scoped to this field.
      // Reuse the existing navigate() + patientHash() helpers — see
      // QueueView.tsx for the pattern. If the route has a criterion_id
      // segment, pass field_id as the criterion_id.
      navigate(patientHash(taskId, patientId, fieldId));
    }}
  />
)}
```

Add the import at the top:

```tsx
import { RevisitList } from "./RevisitList";
```

If `navigate` and `patientHash` are not already in scope, import them the same way other tabs in this file already do.

If the existing tabs don't match the simple pattern above (e.g., they use a different state-variable name or routing scheme), adapt to whatever convention is already in place. Don't restructure unrelated tabs.

- [ ] **Step 3: Type-check + run client tests**

```bash
cd chart-review-platform/app && npx tsc --noEmit -p client/tsconfig.json 2>&1 | grep "IterDetail\|RevisitList\|error TS" | head -10
cd chart-review-platform/app && npx vitest run 2>&1 | tail -10
```

Expected: no new errors; all tests pass.

- [ ] **Step 4: Manual smoke test**

```bash
cd chart-review-platform && npm run dev
```

In the browser:
1. Navigate to a Pilot iter that has a criterion edit since the prior iter.
2. Click the new "Revisits" tab.
3. Verify the grouped list appears with at least one row.
4. Click "keep prior" on one row → row disappears.
5. Click "Mark all as keep prior" on a group → group disappears.
6. Click "re-annotate" → routes to the patient review surface scoped to that criterion.

Document any unexpected UX in the commit message.

- [ ] **Step 5: Commit**

```bash
cd "/Users/xinghe/Downloads/Chart Review Agents"
git branch --show-current   # verify feat/guideline-revisit-list
git add chart-review-platform/app/client/src/ui/PilotsTab/IterDetail.tsx
git commit -m "feat(client): add Revisits tab to PilotsTab IterDetail

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- [x] **Spec coverage:**
  - `captured_against_schema_hash` on FieldAssessment → Task 1.
  - Stamping at commit time → Task 2.
  - `computeRevisitsForIter` → Task 3.
  - GET /revisits route → Task 4.
  - POST /revisits/bulk-keep → Task 5.
  - RevisitList component → Task 6.
  - Wired into PilotsTab → Task 7.
  - Spec resolved decisions (no preview, no schema-break special case, tombstones forever) — already baked into the data flow; no new tasks needed for them.
  - Out-of-scope items (no auto-confirm, no grid, no preview) — explicitly skipped.

- [x] **Placeholder scan:**
  - Tasks 2 and 3 contain `expect(true).toBe(true)` placeholders inside test scaffolds. The notes spell out what each test must assert and point at existing fixture patterns to reuse. The implementer must replace each placeholder with a real assertion. **This is acceptable for tests that need fixture infrastructure.** No code-side placeholders.
  - Two minor `// TODO`-style comments in the code: one in Task 5 (`agent's evidence not threaded yet — see open question in spec`) — that's a known limitation, documented, not a placeholder. One inline note about cycle-breaking imports in Task 2 — actionable.

- [x] **Type consistency:**
  - `captured_against_schema_hash` named consistently across server type, client type, route response, helper return, store write. ✓
  - `RevisitRow` shape consistent between Task 3 (server) and Task 6 (client local interface). ✓
  - `bulkKeepRevisits` signature consistent: `{ taskId, fieldId, patientIds, reviewerId }` in both Task 5 declarations. ✓

---

## Execution Handoff

Plan complete and saved to `chart-review-platform/docs/superpowers/plans/2026-05-05-guideline-revisit-list.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
