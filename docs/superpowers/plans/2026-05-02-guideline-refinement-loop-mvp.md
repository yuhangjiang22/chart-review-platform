# Guideline Refinement Loop MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Studio → Pilots tab to drive the dev-iteration loop, the lock test, and the per-iter / lock report — taking a drafted guideline through to a `locked` state with documented agent performance.

**Architecture:** Single-oracle iterative refinement. Agent annotates a frozen DEV cohort; oracle validates with copilot help; per-criterion accuracy + override clusters surface in `pilots/iter_NNN/`; methodologist applies guideline edits manually; a held-out LOCK cohort gates the `calibrated → locked` maturity transition. Extends — does not replace — the existing Studio Pilots tab and the existing `app/server/pilots.ts` / `maturity.ts` infrastructure.

**Tech Stack:** TypeScript / Node / Express on the server; React + Vite + Tailwind + shadcn/ui on the client; Vitest for unit tests; Playwright for e2e (`app/e2e/vibe-chart-review.spec.ts`, sequential, workers:1).

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-05-02-guideline-refinement-loop-mvp-design.md`
- Visual mock: `docs/superpowers/specs/2026-05-02-pilots-tab-mvp-mock.html`

---

## File Map

### New server files
- `app/server/cohort-sampling.ts` — read/write `guidelines/<task_id>/sampling.json` (DEV + LOCK cohort definitions). Distinct from the existing stratified-random `app/server/sampling.ts`.
- `app/server/iter-accuracy.ts` — walks `reviews/<patient>/<task_id>/review_state.json` for a cohort, compares `original_agent_snapshot` to final answer per `field_assessment`, emits per-criterion accuracy table.
- `app/server/lock-test.ts` — orchestrates the lock test: agent run on LOCK cohort + oracle annotations + final accuracy + maturity gate.
- `app/server/eligibility.ts` — pure utility: given the last K iter critiques, return whether the dev loop is *eligible* for lock test (per spec §5).
- `app/server/__tests__/cohort-sampling.test.ts`
- `app/server/__tests__/iter-accuracy.test.ts`
- `app/server/__tests__/lock-test.test.ts`
- `app/server/__tests__/eligibility.test.ts`

### Modified server files
- `app/server/pilots.ts` — extend `PilotListing` with `accuracy_summary` (worst + avg); compute it in the `/api/pilots/:taskId` handler.
- `app/server/server.ts` — register new routes for cohort sampling, lock test, eligibility.
- `app/server/maturity.ts` — gate `calibrated → locked` on a passed lock test.
- `app/server/skills/`(via system prompt for review-copilot) — accept `blind_mode: boolean` flag that disables the "explain agent rationale" mode.

### New client files
- `app/client/src/v2/PilotsTab/` — directory split for the growing tab:
  - `app/client/src/v2/PilotsTab/index.tsx` — exports `PilotsFigure` (replaces inline implementation in `Studio.tsx`).
  - `app/client/src/v2/PilotsTab/TrajectoryChart.tsx` — SVG line chart, per-criterion accuracy across iterations.
  - `app/client/src/v2/PilotsTab/IterDetail.tsx` — expanded panel with accuracy table, validation chips, override clusters.
  - `app/client/src/v2/PilotsTab/EligibilityPip.tsx` — small ●○ N-of-2 indicator.
  - `app/client/src/v2/PilotsTab/LockTestRow.tsx` — visually distinct row for the lock-test iter.
  - `app/client/src/v2/PilotsTab/LockTestPatientGrid.tsx` — 30-cell patient progress grid.
  - `app/client/src/v2/PilotsTab/CohortCurationModal.tsx` — modal to pick DEV/LOCK patients.
  - `app/client/src/v2/PilotsTab/AuthoringHandoffCard.tsx` — single hero card for the just-promoted state.
- `app/client/src/v2/__tests__/eligibility-ui.test.tsx` — component test for `EligibilityPip`.

### Modified client files
- `app/client/src/v2/Studio.tsx` — remove the inline `PilotsFigure` body and the `PilotListing` interface; import them from `PilotsTab/index.tsx` and `PilotsTab/types.ts`. The tabs list itself stays.

### E2E
- `app/e2e/vibe-chart-review.spec.ts` — extend the existing `test.describe("vibe chart review — full e2e")` block with new tests after the existing pilot-iteration test (currently `test 5`). Numbered tests share state in order.

---

## Task 1: Cohort sampling — types and reader/writer

**Files:**
- Create: `app/server/cohort-sampling.ts`
- Test: `app/server/__tests__/cohort-sampling.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `app/server/__tests__/cohort-sampling.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  readCohortSampling,
  writeCohortSampling,
  type CohortSampling,
} from "../cohort-sampling.js";

describe("cohort-sampling", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-"));
    fs.mkdirSync(path.join(tmp, "guidelines", "test-task"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("returns null when sampling.json is absent", () => {
    expect(readCohortSampling(tmp, "test-task")).toBeNull();
  });

  it("round-trips a cohort definition", () => {
    const cohort: CohortSampling = {
      task_id: "test-task",
      version: 1,
      created_at: "2026-05-02T00:00:00.000Z",
      created_by: "test_pi",
      dev_patient_ids: ["p_dev_01", "p_dev_02"],
      lock_patient_ids: ["p_lock_01", "p_lock_02", "p_lock_03"],
      stratification_notes: "≥1 positive, ≥1 negative, ≥1 edge per primary criterion",
    };
    writeCohortSampling(tmp, "test-task", cohort);
    expect(readCohortSampling(tmp, "test-task")).toEqual(cohort);
  });

  it("rejects DEV/LOCK overlap", () => {
    const bad: CohortSampling = {
      task_id: "test-task",
      version: 1,
      created_at: "2026-05-02T00:00:00.000Z",
      created_by: "test_pi",
      dev_patient_ids: ["p_01", "p_02"],
      lock_patient_ids: ["p_02", "p_03"],
    };
    expect(() => writeCohortSampling(tmp, "test-task", bad)).toThrow(/overlap/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && npx vitest run server/__tests__/cohort-sampling.test.ts
```

Expected: FAIL with `Cannot find module '../cohort-sampling'`.

- [ ] **Step 3: Implement `cohort-sampling.ts`**

Path: `app/server/cohort-sampling.ts`

```ts
import fs from "fs";
import path from "path";

export interface CohortSampling {
  task_id: string;
  version: number;
  created_at: string;
  created_by: string;
  dev_patient_ids: string[];
  lock_patient_ids: string[];
  stratification_notes?: string;
}

function samplingPath(rootDir: string, taskId: string): string {
  return path.join(rootDir, "guidelines", taskId, "sampling.json");
}

export function readCohortSampling(rootDir: string, taskId: string): CohortSampling | null {
  const p = samplingPath(rootDir, taskId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as CohortSampling;
}

export function writeCohortSampling(rootDir: string, taskId: string, cohort: CohortSampling): void {
  if (cohort.task_id !== taskId) {
    throw new Error(`cohort.task_id (${cohort.task_id}) does not match taskId (${taskId})`);
  }
  const dev = new Set(cohort.dev_patient_ids);
  const overlap = cohort.lock_patient_ids.filter((id) => dev.has(id));
  if (overlap.length > 0) {
    throw new Error(`DEV and LOCK cohorts overlap on: ${overlap.join(", ")}`);
  }
  const p = samplingPath(rootDir, taskId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cohort, null, 2));
}

export function defaultCohortSizes(): { dev: number; lock: number } {
  return { dev: 10, lock: 30 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run server/__tests__/cohort-sampling.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/cohort-sampling.ts app/server/__tests__/cohort-sampling.test.ts
git commit -m "feat(server): cohort sampling.json reader/writer for refinement loop"
```

---

## Task 2: Cohort sampling — server endpoints

**Files:**
- Modify: `app/server/server.ts` (add routes near the existing `/api/pilots/:taskId` block, ~line 1221)

- [ ] **Step 1: Write the failing test**

Path: `app/server/__tests__/cohort-sampling.test.ts` (append to existing file)

```ts
import express from "express";
import request from "supertest";
import { registerCohortSamplingRoutes } from "../cohort-sampling.js";

it("GET returns 404 when no cohort exists, 200 with body when it does", async () => {
  const app = express();
  app.use(express.json());
  registerCohortSamplingRoutes(app, tmp);

  let r = await request(app).get("/api/cohort-sampling/test-task");
  expect(r.status).toBe(404);

  await request(app).put("/api/cohort-sampling/test-task").send({
    task_id: "test-task",
    version: 1,
    created_at: "2026-05-02T00:00:00.000Z",
    created_by: "test_pi",
    dev_patient_ids: ["p_dev_01"],
    lock_patient_ids: ["p_lock_01"],
  });

  r = await request(app).get("/api/cohort-sampling/test-task");
  expect(r.status).toBe(200);
  expect(r.body.dev_patient_ids).toEqual(["p_dev_01"]);
});
```

- [ ] **Step 2: Run test (will fail — `registerCohortSamplingRoutes` not exported yet)**

```bash
cd app && npx vitest run server/__tests__/cohort-sampling.test.ts
```

- [ ] **Step 3: Add `registerCohortSamplingRoutes` export to `cohort-sampling.ts`**

Append to `app/server/cohort-sampling.ts`:

```ts
import type { Express, Request, Response } from "express";

export function registerCohortSamplingRoutes(app: Express, rootDir: string): void {
  app.get("/api/cohort-sampling/:taskId", (req: Request, res: Response) => {
    const cohort = readCohortSampling(rootDir, req.params.taskId);
    if (!cohort) return res.status(404).json({ error: "no_cohort_yet" });
    return res.json(cohort);
  });

  app.put("/api/cohort-sampling/:taskId", (req: Request, res: Response) => {
    try {
      writeCohortSampling(rootDir, req.params.taskId, req.body);
      return res.status(204).end();
    } catch (e) {
      return res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });
}
```

- [ ] **Step 4: Wire the routes into the main server**

Modify `app/server/server.ts` near the `/api/pilots/:taskId` block (line ~1221). Add at the top of the file's import section:

```ts
import { registerCohortSamplingRoutes } from "./cohort-sampling.js";
```

And right after `app.use(express.json())` (or wherever middleware is configured before route declarations), call:

```ts
registerCohortSamplingRoutes(app, PLATFORM_ROOT);
```

(`PLATFORM_ROOT` is exported from `app/server/patients.ts` and used widely in this file already.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd app && npx vitest run server/__tests__/cohort-sampling.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 6: Install supertest if not already present**

```bash
cd app && npm ls supertest @types/supertest 2>/dev/null || npm install -D supertest @types/supertest
```

- [ ] **Step 7: Commit**

```bash
git add app/server/cohort-sampling.ts app/server/__tests__/cohort-sampling.test.ts app/server/server.ts app/package.json app/package-lock.json
git commit -m "feat(server): GET/PUT /api/cohort-sampling/:taskId endpoints"
```

---

## Task 3: Per-iter accuracy — pure compute utility

**Files:**
- Create: `app/server/iter-accuracy.ts`
- Test: `app/server/__tests__/iter-accuracy.test.ts`

The shape we compute is:
```ts
interface PerCriterionAccuracy {
  field_id: string;
  n_evaluable: number;       // patients where this criterion is applicable per oracle
  n_correct: number;         // agent answer matched final reviewer answer
  accuracy: number | null;   // n_correct / n_evaluable; null if n_evaluable == 0
}
interface IterAccuracy {
  task_id: string;
  iter_id: string;
  cohort_kind: "dev" | "lock";
  patient_ids: string[];
  per_criterion: PerCriterionAccuracy[];
  worst_accuracy: { field_id: string; accuracy: number } | null;
  avg_accuracy: number | null;
  override_count: number;
  computed_at: string;
}
```

Read each patient's `reviews/<patient>/<task_id>/review_state.json`. For each `field_assessments[i]`:
- Skip derived fields (we'll filter by criterion list later — for this pure function, take a `primary_criterion_ids: string[]` param).
- The "agent answer" is `original_agent_snapshot.answer` if `source === "reviewer"` (override case) OR `answer` if `source === "agent"` (accepted as-is).
- The "final answer" is whatever's currently in `answer` regardless of source.
- Match if both are deep-equal (use `JSON.stringify` as the cheap path; arrays compare element-wise after sort).
- "Evaluable" = the assessment exists at all (skip if no assessment for this field on this patient).

- [ ] **Step 1: Write the failing test**

Path: `app/server/__tests__/iter-accuracy.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { computeIterAccuracy } from "../iter-accuracy.js";

function writeReview(root: string, pid: string, taskId: string, assessments: any[]) {
  const dir = path.join(root, "reviews", pid, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    schema_version: "1",
    patient_id: pid,
    task_id: taskId,
    review_status: "in_progress",
    version: 1,
    field_assessments: assessments,
  }));
}

describe("iter-accuracy", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iter-")); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("counts agent_proposed (no override) as correct", () => {
    writeReview(tmp, "p1", "t1", [
      { field_id: "f1", answer: true, source: "agent", status: "agent_proposed" },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp,
      taskId: "t1",
      iterId: "iter_001",
      cohortKind: "dev",
      patientIds: ["p1"],
      primaryCriterionIds: ["f1"],
    });
    expect(acc.per_criterion[0]).toMatchObject({ field_id: "f1", n_evaluable: 1, n_correct: 1, accuracy: 1 });
    expect(acc.override_count).toBe(0);
  });

  it("counts overridden (different answer) as incorrect", () => {
    writeReview(tmp, "p1", "t1", [
      {
        field_id: "f1", answer: false, source: "reviewer", status: "overridden",
        original_agent_snapshot: { answer: true },
      },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp, taskId: "t1", iterId: "iter_001", cohortKind: "dev",
      patientIds: ["p1"], primaryCriterionIds: ["f1"],
    });
    expect(acc.per_criterion[0]).toMatchObject({ field_id: "f1", n_evaluable: 1, n_correct: 0, accuracy: 0 });
    expect(acc.override_count).toBe(1);
  });

  it("counts overridden-to-same-answer as correct (rare but possible)", () => {
    writeReview(tmp, "p1", "t1", [
      {
        field_id: "f1", answer: true, source: "reviewer", status: "overridden",
        original_agent_snapshot: { answer: true },
      },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp, taskId: "t1", iterId: "iter_001", cohortKind: "dev",
      patientIds: ["p1"], primaryCriterionIds: ["f1"],
    });
    expect(acc.per_criterion[0].accuracy).toBe(1);
  });

  it("ignores non-primary criteria", () => {
    writeReview(tmp, "p1", "t1", [
      { field_id: "derived_x", answer: 42, source: "agent", status: "agent_proposed" },
      { field_id: "f1", answer: true, source: "agent", status: "agent_proposed" },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp, taskId: "t1", iterId: "iter_001", cohortKind: "dev",
      patientIds: ["p1"], primaryCriterionIds: ["f1"],
    });
    expect(acc.per_criterion).toHaveLength(1);
    expect(acc.per_criterion[0].field_id).toBe("f1");
  });

  it("aggregates worst and avg across criteria", () => {
    writeReview(tmp, "p1", "t1", [
      { field_id: "f1", answer: true,  source: "agent", status: "agent_proposed" },
      { field_id: "f2", answer: false, source: "reviewer", status: "overridden",
        original_agent_snapshot: { answer: true } },
    ]);
    writeReview(tmp, "p2", "t1", [
      { field_id: "f1", answer: true, source: "agent", status: "agent_proposed" },
      { field_id: "f2", answer: true, source: "agent", status: "agent_proposed" },
    ]);
    const acc = computeIterAccuracy({
      rootDir: tmp, taskId: "t1", iterId: "iter_001", cohortKind: "dev",
      patientIds: ["p1", "p2"], primaryCriterionIds: ["f1", "f2"],
    });
    expect(acc.per_criterion.find(c => c.field_id === "f1")!.accuracy).toBe(1);
    expect(acc.per_criterion.find(c => c.field_id === "f2")!.accuracy).toBe(0.5);
    expect(acc.worst_accuracy).toEqual({ field_id: "f2", accuracy: 0.5 });
    expect(acc.avg_accuracy).toBe(0.75);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && npx vitest run server/__tests__/iter-accuracy.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement `iter-accuracy.ts`**

Path: `app/server/iter-accuracy.ts`

```ts
import fs from "fs";
import path from "path";

export interface PerCriterionAccuracy {
  field_id: string;
  n_evaluable: number;
  n_correct: number;
  accuracy: number | null;
}

export interface IterAccuracy {
  task_id: string;
  iter_id: string;
  cohort_kind: "dev" | "lock";
  patient_ids: string[];
  per_criterion: PerCriterionAccuracy[];
  worst_accuracy: { field_id: string; accuracy: number } | null;
  avg_accuracy: number | null;
  override_count: number;
  computed_at: string;
}

export interface ComputeIterAccuracyArgs {
  rootDir: string;
  taskId: string;
  iterId: string;
  cohortKind: "dev" | "lock";
  patientIds: string[];
  primaryCriterionIds: string[];
}

interface FieldAssessment {
  field_id: string;
  answer: unknown;
  source: "agent" | "reviewer";
  status: string;
  original_agent_snapshot?: { answer: unknown };
}

interface ReviewState { field_assessments: FieldAssessment[] }

function answersEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function computeIterAccuracy(args: ComputeIterAccuracyArgs): IterAccuracy {
  const primarySet = new Set(args.primaryCriterionIds);
  const counts: Record<string, { evaluable: number; correct: number }> = {};
  for (const fid of args.primaryCriterionIds) counts[fid] = { evaluable: 0, correct: 0 };
  let overrides = 0;

  for (const pid of args.patientIds) {
    const reviewPath = path.join(args.rootDir, "reviews", pid, args.taskId, "review_state.json");
    if (!fs.existsSync(reviewPath)) continue;
    const state: ReviewState = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    for (const fa of state.field_assessments ?? []) {
      if (!primarySet.has(fa.field_id)) continue;
      const slot = counts[fa.field_id];
      slot.evaluable += 1;
      const finalAnswer = fa.answer;
      const agentAnswer = fa.source === "reviewer" && fa.original_agent_snapshot
        ? fa.original_agent_snapshot.answer
        : fa.answer;
      const isOverride = fa.source === "reviewer" && fa.status === "overridden";
      if (isOverride) overrides += 1;
      if (answersEqual(agentAnswer, finalAnswer)) slot.correct += 1;
    }
  }

  const per_criterion: PerCriterionAccuracy[] = args.primaryCriterionIds.map((fid) => {
    const c = counts[fid];
    return {
      field_id: fid,
      n_evaluable: c.evaluable,
      n_correct: c.correct,
      accuracy: c.evaluable === 0 ? null : c.correct / c.evaluable,
    };
  });

  const accNumbers = per_criterion
    .filter((c) => c.accuracy != null)
    .map((c) => ({ field_id: c.field_id, accuracy: c.accuracy as number }));
  const worst_accuracy = accNumbers.length === 0
    ? null
    : accNumbers.reduce((a, b) => (a.accuracy <= b.accuracy ? a : b));
  const avg_accuracy = accNumbers.length === 0
    ? null
    : accNumbers.reduce((s, c) => s + c.accuracy, 0) / accNumbers.length;

  return {
    task_id: args.taskId,
    iter_id: args.iterId,
    cohort_kind: args.cohortKind,
    patient_ids: args.patientIds,
    per_criterion,
    worst_accuracy,
    avg_accuracy,
    override_count: overrides,
    computed_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run server/__tests__/iter-accuracy.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/iter-accuracy.ts app/server/__tests__/iter-accuracy.test.ts
git commit -m "feat(server): per-criterion accuracy computer for refinement iterations"
```

---

## Task 4: Per-iter accuracy — persist to `pilots/iter_NNN/critique.json` + report.md

**Files:**
- Modify: `app/server/iter-accuracy.ts` (add `persistIterAccuracy` and `writeIterReport`)
- Modify: `app/server/__tests__/iter-accuracy.test.ts` (append tests)

The existing `pilots/iter_NNN/critique.json` already has fields like `proposal_count`, `cost_usd`. We extend it with `accuracy` (the new `IterAccuracy` shape). The report.md is a new sibling file.

- [ ] **Step 1: Append failing tests**

```ts
import { persistIterAccuracy, writeIterReport } from "../iter-accuracy.js";

it("persistIterAccuracy merges into existing critique.json without dropping fields", () => {
  const iterDir = path.join(tmp, "guidelines", "t1", "pilots", "iter_001");
  fs.mkdirSync(iterDir, { recursive: true });
  fs.writeFileSync(path.join(iterDir, "critique.json"), JSON.stringify({
    proposal_count: 3, cost_usd: 0.12, ran_at: "2026-05-01T00:00:00.000Z",
  }));

  const acc: any = {
    task_id: "t1", iter_id: "iter_001", cohort_kind: "dev",
    patient_ids: ["p1"], per_criterion: [], worst_accuracy: null,
    avg_accuracy: null, override_count: 0, computed_at: "2026-05-02T00:00:00.000Z",
  };
  persistIterAccuracy(tmp, "t1", "iter_001", acc);

  const merged = JSON.parse(fs.readFileSync(path.join(iterDir, "critique.json"), "utf8"));
  expect(merged.proposal_count).toBe(3);
  expect(merged.cost_usd).toBe(0.12);
  expect(merged.accuracy).toEqual(acc);
});

it("writeIterReport writes a markdown report at the iter dir", () => {
  const iterDir = path.join(tmp, "guidelines", "t1", "pilots", "iter_001");
  fs.mkdirSync(iterDir, { recursive: true });
  const acc: any = {
    task_id: "t1", iter_id: "iter_001", cohort_kind: "dev",
    patient_ids: ["p1", "p2"],
    per_criterion: [
      { field_id: "f1", n_evaluable: 2, n_correct: 2, accuracy: 1.0 },
      { field_id: "f2", n_evaluable: 2, n_correct: 1, accuracy: 0.5 },
    ],
    worst_accuracy: { field_id: "f2", accuracy: 0.5 },
    avg_accuracy: 0.75,
    override_count: 1,
    computed_at: "2026-05-02T00:00:00.000Z",
  };
  writeIterReport(tmp, "t1", "iter_001", acc);
  const md = fs.readFileSync(path.join(iterDir, "report.md"), "utf8");
  expect(md).toContain("iter_001");
  expect(md).toContain("f1");
  expect(md).toContain("f2");
  expect(md).toContain("0.50");
});
```

- [ ] **Step 2: Run test (will fail — both functions missing)**

```bash
cd app && npx vitest run server/__tests__/iter-accuracy.test.ts
```

- [ ] **Step 3: Implement `persistIterAccuracy` and `writeIterReport`**

Append to `app/server/iter-accuracy.ts`:

```ts
function iterDirOf(rootDir: string, taskId: string, iterId: string): string {
  return path.join(rootDir, "guidelines", taskId, "pilots", iterId);
}

export function persistIterAccuracy(
  rootDir: string,
  taskId: string,
  iterId: string,
  accuracy: IterAccuracy,
): void {
  const dir = iterDirOf(rootDir, taskId, iterId);
  fs.mkdirSync(dir, { recursive: true });
  const critiquePath = path.join(dir, "critique.json");
  const existing = fs.existsSync(critiquePath)
    ? JSON.parse(fs.readFileSync(critiquePath, "utf8"))
    : {};
  fs.writeFileSync(critiquePath, JSON.stringify({ ...existing, accuracy }, null, 2));
}

function fmtAcc(a: number | null): string {
  return a == null ? "—" : a.toFixed(2);
}

export function writeIterReport(
  rootDir: string,
  taskId: string,
  iterId: string,
  accuracy: IterAccuracy,
): void {
  const dir = iterDirOf(rootDir, taskId, iterId);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  lines.push(`# ${iterId} — ${taskId}`);
  lines.push("");
  lines.push(`Cohort: ${accuracy.cohort_kind} · n=${accuracy.patient_ids.length} · computed ${accuracy.computed_at}`);
  lines.push("");
  lines.push("## Per-criterion accuracy");
  lines.push("");
  lines.push("| criterion | n | accuracy |");
  lines.push("|-----------|---|----------|");
  for (const c of accuracy.per_criterion) {
    lines.push(`| \`${c.field_id}\` | ${c.n_evaluable} | ${fmtAcc(c.accuracy)} |`);
  }
  lines.push("");
  lines.push(`Worst: \`${accuracy.worst_accuracy?.field_id ?? "—"}\` at ${fmtAcc(accuracy.worst_accuracy?.accuracy ?? null)}`);
  lines.push(`Average: ${fmtAcc(accuracy.avg_accuracy)}`);
  lines.push(`Override count: ${accuracy.override_count}`);
  fs.writeFileSync(path.join(dir, "report.md"), lines.join("\n") + "\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run server/__tests__/iter-accuracy.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/iter-accuracy.ts app/server/__tests__/iter-accuracy.test.ts
git commit -m "feat(server): persist per-iter accuracy to critique.json + report.md"
```

---

## Task 5: Wire accuracy compute into the existing critique endpoint

**Files:**
- Modify: `app/server/pilots.ts`
- Modify: `app/server/server.ts` (the existing `/api/pilots/:taskId/:iterId/critique` POST handler at ~line 1373)

The existing `critique` endpoint runs `improveGuideline` to cluster overrides into proposals. We extend it to *also* compute and persist iter accuracy.

- [ ] **Step 1: Read the existing critique handler**

Open `app/server/server.ts` and read the body of the `app.post("/api/pilots/:taskId/:iterId/critique"` handler (~line 1373). Note:
- It calls `improveGuideline()` from `guideline-improvement.ts`.
- It reads the iter's manifest to get `patient_ids` (or via the run).
- It writes `pilots/<iterId>/critique.json`.

- [ ] **Step 2: Add a helper in pilots.ts for primary criterion ids**

In `app/server/pilots.ts`, add:

```ts
import yaml from "js-yaml";

/** Primary = reviewer-emitted criterion (no `derivation` field). */
export function readPrimaryCriterionIds(rootDir: string, taskId: string): string[] {
  const dir = path.join(rootDir, "guidelines", taskId, "criteria");
  if (!fs.existsSync(dir)) return [];
  const ids: string[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
    const doc = yaml.load(fs.readFileSync(path.join(dir, f), "utf8")) as { id?: string; derivation?: unknown };
    if (doc?.id && doc.derivation == null) ids.push(doc.id);
  }
  return ids.sort();
}
```

(Confirm `js-yaml` is already in `package.json` — it is, used elsewhere in the server.)

- [ ] **Step 3: Add a unit test for the new helper**

Append to `app/server/__tests__/iter-accuracy.test.ts`:

```ts
import { readPrimaryCriterionIds } from "../pilots.js";

it("readPrimaryCriterionIds skips derived fields", () => {
  const dir = path.join(tmp, "guidelines", "t1", "criteria");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "f1.yaml"), "id: f1\nprompt: foo\n");
  fs.writeFileSync(path.join(dir, "f2.yaml"), "id: f2\nprompt: bar\nderivation: { expr: 'f1' }\n");
  fs.writeFileSync(path.join(dir, "f3.yaml"), "id: f3\nprompt: baz\n");
  expect(readPrimaryCriterionIds(tmp, "t1")).toEqual(["f1", "f3"]);
});
```

Run, confirm pass:

```bash
cd app && npx vitest run server/__tests__/iter-accuracy.test.ts
```

- [ ] **Step 4: Modify the critique endpoint in server.ts**

In `app/server/server.ts`, find the `app.post("/api/pilots/:taskId/:iterId/critique"` handler. Add at the top of the file's imports:

```ts
import { computeIterAccuracy, persistIterAccuracy, writeIterReport } from "./iter-accuracy.js";
import { readPrimaryCriterionIds } from "./pilots.js";
import { readCohortSampling } from "./cohort-sampling.js";
```

Inside the handler body, after `improveGuideline` completes successfully and before the response is sent, add:

```ts
// Per-iter accuracy compute — runs alongside the critique clustering.
try {
  const cohort = readCohortSampling(PLATFORM_ROOT, taskId);
  const primaryCriterionIds = readPrimaryCriterionIds(PLATFORM_ROOT, taskId);
  if (cohort && primaryCriterionIds.length > 0) {
    const accuracy = computeIterAccuracy({
      rootDir: PLATFORM_ROOT,
      taskId,
      iterId,
      cohortKind: "dev",
      patientIds: cohort.dev_patient_ids,
      primaryCriterionIds,
    });
    persistIterAccuracy(PLATFORM_ROOT, taskId, iterId, accuracy);
    writeIterReport(PLATFORM_ROOT, taskId, iterId, accuracy);
  }
} catch (err) {
  console.error(`[refinement-loop] accuracy compute failed for ${taskId}/${iterId}:`, err);
}
```

- [ ] **Step 5: Run vitest + restart-then-curl smoke**

```bash
cd app && npx vitest run server/__tests__/
```

Then in a separate terminal, restart the dev server (`npm run dev`) and verify the existing critique POST still 200s on a known iter.

- [ ] **Step 6: Commit**

```bash
git add app/server/server.ts app/server/pilots.ts app/server/__tests__/iter-accuracy.test.ts
git commit -m "feat(server): compute per-iter accuracy alongside critique clustering"
```

---

## Task 6: Eligibility — pure utility

**Files:**
- Create: `app/server/eligibility.ts`
- Test: `app/server/__tests__/eligibility.test.ts`

Per spec §5: eligible iff for **two consecutive iterations**, every primary criterion has accuracy ≥ 0.9 AND override rate did not increase AND no new override clusters.

For the MVP we approximate "no new override clusters" by `override_count` not exceeding the previous iter's count. (Cluster-level dedup is a future tightening — clusters are a UI presentation; the underlying signal is override count and per-criterion thresholds.)

- [ ] **Step 1: Write the failing test**

Path: `app/server/__tests__/eligibility.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { computeEligibility, type IterSnapshot } from "../eligibility.js";

const passIter = (override_count = 1): IterSnapshot => ({
  iter_id: "iter_x",
  per_criterion: [
    { field_id: "f1", accuracy: 0.95, n_evaluable: 10, n_correct: 9 },
    { field_id: "f2", accuracy: 0.92, n_evaluable: 10, n_correct: 9 },
  ],
  override_count,
});

const failIter = (): IterSnapshot => ({
  iter_id: "iter_y",
  per_criterion: [
    { field_id: "f1", accuracy: 0.85, n_evaluable: 10, n_correct: 8 },
  ],
  override_count: 5,
});

describe("eligibility", () => {
  it("eligible when last two iters both pass and overrides didn't grow", () => {
    expect(computeEligibility([passIter(2), passIter(1)]).eligible).toBe(true);
  });
  it("not eligible with only one passing iter", () => {
    expect(computeEligibility([failIter(), passIter()]).eligible).toBe(false);
  });
  it("not eligible if override_count grew", () => {
    expect(computeEligibility([passIter(3), passIter(1)]).eligible).toBe(false);
  });
  it("not eligible if any criterion < 0.9", () => {
    const last = passIter();
    last.per_criterion[0].accuracy = 0.85;
    expect(computeEligibility([passIter(), last]).eligible).toBe(false);
  });
  it("returns 1-of-2 progress when only the most recent passes", () => {
    const r = computeEligibility([failIter(), passIter()]);
    expect(r.consecutive_passing).toBe(1);
  });
});
```

- [ ] **Step 2: Run test (fails — module missing)**

```bash
cd app && npx vitest run server/__tests__/eligibility.test.ts
```

- [ ] **Step 3: Implement `eligibility.ts`**

Path: `app/server/eligibility.ts`

```ts
export interface IterSnapshot {
  iter_id: string;
  per_criterion: Array<{ field_id: string; accuracy: number | null; n_evaluable: number; n_correct: number }>;
  override_count: number;
}

export interface EligibilityResult {
  eligible: boolean;
  consecutive_passing: number;
  required_consecutive: number;
  failing_criteria: Array<{ field_id: string; accuracy: number | null; iter_id: string }>;
  override_growth: number; // most recent - previous; positive means it grew
}

const THRESHOLD = 0.9;
const REQUIRED_CONSECUTIVE = 2;

function passes(iter: IterSnapshot): boolean {
  return iter.per_criterion.every((c) => c.accuracy != null && c.accuracy >= THRESHOLD);
}

/**
 * iters: array ordered oldest → newest. Computes whether the *most recent
 * REQUIRED_CONSECUTIVE iters* all pass and override_count is non-increasing.
 */
export function computeEligibility(iters: IterSnapshot[]): EligibilityResult {
  const last = iters.slice(-REQUIRED_CONSECUTIVE);
  let consecutive = 0;
  for (let i = iters.length - 1; i >= 0 && passes(iters[i]); i--) {
    consecutive += 1;
    if (consecutive === REQUIRED_CONSECUTIVE) break;
  }
  const failing: EligibilityResult["failing_criteria"] = [];
  for (const it of last) {
    for (const c of it.per_criterion) {
      if (c.accuracy == null || c.accuracy < THRESHOLD) {
        failing.push({ field_id: c.field_id, accuracy: c.accuracy, iter_id: it.iter_id });
      }
    }
  }
  const overrideGrowth = last.length === 2 ? last[1].override_count - last[0].override_count : 0;
  const eligible = consecutive >= REQUIRED_CONSECUTIVE && overrideGrowth <= 0;
  return {
    eligible,
    consecutive_passing: consecutive,
    required_consecutive: REQUIRED_CONSECUTIVE,
    failing_criteria: failing,
    override_growth: overrideGrowth,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run server/__tests__/eligibility.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/eligibility.ts app/server/__tests__/eligibility.test.ts
git commit -m "feat(server): pure eligibility utility for lock-test gate"
```

---

## Task 7: Eligibility — server endpoint + iter accuracy in PilotListing

**Files:**
- Modify: `app/server/pilots.ts` (extend `PilotListing`, populate `accuracy_summary`)
- Modify: `app/server/server.ts` (add `/api/pilots/:taskId/eligibility` route)

- [ ] **Step 1: Extend PilotListing in `pilots.ts`**

Find `interface PilotListing` and add:

```ts
export interface PilotListing extends PilotManifest {
  // ...existing fields...
  /** Refinement-loop addition: per-iter accuracy summary, populated when
   *  the iter's critique.json contains an `accuracy` block. */
  accuracy_summary?: {
    worst: { field_id: string; accuracy: number } | null;
    avg: number | null;
    override_count: number;
  } | null;
}
```

- [ ] **Step 2: Populate `accuracy_summary` in the listing handler**

In `app/server/pilots.ts`, find the `listPilots` (or equivalent) function that produces `PilotListing[]` for `/api/pilots/:taskId`. After it reads `critique.json` for the iter, add:

```ts
let accuracy_summary: PilotListing["accuracy_summary"] = null;
if (critique?.accuracy) {
  const a = critique.accuracy as { worst_accuracy: { field_id: string; accuracy: number } | null; avg_accuracy: number | null; override_count: number };
  accuracy_summary = { worst: a.worst_accuracy, avg: a.avg_accuracy, override_count: a.override_count };
}
// then include `accuracy_summary` in the returned listing object
```

- [ ] **Step 3: Add a server endpoint for eligibility**

In `app/server/server.ts`, near the existing `/api/pilots/:taskId/stats` handler, add:

```ts
import { computeEligibility, type IterSnapshot } from "./eligibility.js";
// ...
app.get("/api/pilots/:taskId/eligibility", (req, res) => {
  const { taskId } = req.params;
  const pilots = listPilots(taskId); // existing function used by /api/pilots/:taskId
  const iters: IterSnapshot[] = pilots
    .filter((p) => p.state === "complete" && (p.critique as any)?.accuracy)
    .map((p) => {
      const acc = (p.critique as any).accuracy;
      return {
        iter_id: p.iter_id,
        per_criterion: acc.per_criterion,
        override_count: acc.override_count,
      };
    })
    .sort((a, b) => a.iter_id.localeCompare(b.iter_id));
  res.json(computeEligibility(iters));
});
```

- [ ] **Step 4: Add an integration-style test**

Append to `app/server/__tests__/eligibility.test.ts` an end-to-end test that mounts the route on supertest and verifies the response shape against a tmp guidelines dir with two passing critique.json files.

(Skeleton — fill in the details following the Task 2 supertest pattern.)

- [ ] **Step 5: Run tests + smoke the route**

```bash
cd app && npx vitest run server/__tests__/eligibility.test.ts
```

Then with the dev server running:

```bash
curl -s http://localhost:3001/api/pilots/lung-cancer-phenotype/eligibility | jq .
```

Expected: a JSON object with `eligible`, `consecutive_passing`, `required_consecutive: 2`.

- [ ] **Step 6: Commit**

```bash
git add app/server/pilots.ts app/server/server.ts app/server/__tests__/eligibility.test.ts
git commit -m "feat(server): /api/pilots/:taskId/eligibility + accuracy_summary in listings"
```

---

## Task 8: Lock test — types, runner skeleton, manifest

**Files:**
- Create: `app/server/lock-test.ts`
- Test: `app/server/__tests__/lock-test.test.ts`

The lock test is conceptually a dedicated iteration, but with a different layout to keep it separable from `pilots/iter_NNN/`:

```
guidelines/<task_id>/lock_test/
  <run_id>/manifest.json   # { task_id, run_id, started_at, started_by, state, agent_run_id?, guideline_sha, copilot_blind_mode: true }
  <run_id>/accuracy.json   # IterAccuracy with cohort_kind: "lock"
  <run_id>/report.md       # final lock-test report
```

- [ ] **Step 1: Write the failing test**

Path: `app/server/__tests__/lock-test.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { startLockTest, readLockTestManifest, listLockTests } from "../lock-test.js";

describe("lock-test", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lt-")); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("startLockTest writes a manifest with state=running and copilot_blind_mode=true", () => {
    fs.mkdirSync(path.join(tmp, "guidelines", "t1"), { recursive: true });
    const r = startLockTest({
      rootDir: tmp,
      taskId: "t1",
      startedBy: "test_pi",
      guidelineSha: "abc12345",
    });
    const m = readLockTestManifest(tmp, "t1", r.run_id);
    expect(m).toMatchObject({
      task_id: "t1",
      run_id: r.run_id,
      state: "running",
      copilot_blind_mode: true,
      guideline_sha: "abc12345",
      started_by: "test_pi",
    });
  });

  it("listLockTests returns runs newest-first", () => {
    fs.mkdirSync(path.join(tmp, "guidelines", "t1"), { recursive: true });
    const a = startLockTest({ rootDir: tmp, taskId: "t1", startedBy: "u", guidelineSha: "x" });
    // Bump time so run_ids differ deterministically.
    const b = startLockTest({ rootDir: tmp, taskId: "t1", startedBy: "u", guidelineSha: "x" });
    const runs = listLockTests(tmp, "t1");
    expect(runs.length).toBe(2);
    expect(runs[0].run_id >= runs[1].run_id).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (fails — module missing)**

```bash
cd app && npx vitest run server/__tests__/lock-test.test.ts
```

- [ ] **Step 3: Implement `lock-test.ts`**

Path: `app/server/lock-test.ts`

```ts
import fs from "fs";
import path from "path";

export type LockTestState = "running" | "passed" | "failed" | "abandoned";

export interface LockTestManifest {
  task_id: string;
  run_id: string;            // ISO timestamp with `:` → `-` (filesystem-safe)
  guideline_sha: string;
  started_at: string;
  started_by: string;
  state: LockTestState;
  copilot_blind_mode: true;  // always true; enforced platform-side
  agent_run_id?: string;     // populated when the agent batch-run kicks off
  completed_at?: string;
  failure_reason?: string;   // populated when state === "failed"
}

function lockTestRoot(rootDir: string, taskId: string): string {
  return path.join(rootDir, "guidelines", taskId, "lock_test");
}

function lockTestRunDir(rootDir: string, taskId: string, runId: string): string {
  return path.join(lockTestRoot(rootDir, taskId), runId);
}

function manifestPath(rootDir: string, taskId: string, runId: string): string {
  return path.join(lockTestRunDir(rootDir, taskId, runId), "manifest.json");
}

function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function startLockTest(args: {
  rootDir: string;
  taskId: string;
  startedBy: string;
  guidelineSha: string;
}): LockTestManifest {
  const runId = newRunId();
  const m: LockTestManifest = {
    task_id: args.taskId,
    run_id: runId,
    guideline_sha: args.guidelineSha,
    started_at: new Date().toISOString(),
    started_by: args.startedBy,
    state: "running",
    copilot_blind_mode: true,
  };
  const dir = lockTestRunDir(args.rootDir, args.taskId, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(args.rootDir, args.taskId, runId), JSON.stringify(m, null, 2));
  return m;
}

export function readLockTestManifest(rootDir: string, taskId: string, runId: string): LockTestManifest | null {
  const p = manifestPath(rootDir, taskId, runId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as LockTestManifest;
}

export function writeLockTestManifest(rootDir: string, taskId: string, m: LockTestManifest): void {
  fs.writeFileSync(manifestPath(rootDir, taskId, m.run_id), JSON.stringify(m, null, 2));
}

export function listLockTests(rootDir: string, taskId: string): LockTestManifest[] {
  const root = lockTestRoot(rootDir, taskId);
  if (!fs.existsSync(root)) return [];
  const runs: LockTestManifest[] = [];
  for (const d of fs.readdirSync(root)) {
    const m = readLockTestManifest(rootDir, taskId, d);
    if (m) runs.push(m);
  }
  return runs.sort((a, b) => b.run_id.localeCompare(a.run_id));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run server/__tests__/lock-test.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/lock-test.ts app/server/__tests__/lock-test.test.ts
git commit -m "feat(server): lock-test manifest types + start/list/read"
```

---

## Task 9: Lock test — finalize + maturity gate

**Files:**
- Modify: `app/server/lock-test.ts` (add `finalizeLockTest`)
- Modify: `app/server/maturity.ts` (gate `calibrated → locked` on a passed lock test)
- Modify: `app/server/__tests__/lock-test.test.ts` (append tests)

`finalizeLockTest` runs after the oracle completes annotating all lock patients. It computes accuracy on the lock cohort, writes `accuracy.json` + `report.md`, and updates the manifest to `passed` or `failed`.

The maturity transition check looks for a manifest with `state === "passed"` whose `guideline_sha` matches the current task SHA.

- [ ] **Step 1: Append failing tests for finalize**

```ts
import { finalizeLockTest } from "../lock-test.js";
import { computeIterAccuracy } from "../iter-accuracy.js";

it("finalizeLockTest sets state=passed when every primary criterion ≥ 0.9", () => {
  fs.mkdirSync(path.join(tmp, "guidelines", "t1"), { recursive: true });
  const m = startLockTest({ rootDir: tmp, taskId: "t1", startedBy: "u", guidelineSha: "x" });
  // Stub: write a perfect-accuracy artifact directly via iter-accuracy module.
  // (The runner will normally compute this; here we test the finalize gate.)
  const acc = {
    task_id: "t1", iter_id: m.run_id, cohort_kind: "lock" as const,
    patient_ids: ["p1"],
    per_criterion: [
      { field_id: "f1", n_evaluable: 1, n_correct: 1, accuracy: 1.0 },
      { field_id: "f2", n_evaluable: 1, n_correct: 1, accuracy: 0.95 },
    ],
    worst_accuracy: { field_id: "f2", accuracy: 0.95 },
    avg_accuracy: 0.975,
    override_count: 0,
    computed_at: "2026-05-02T00:00:00.000Z",
  };
  const result = finalizeLockTest({ rootDir: tmp, taskId: "t1", runId: m.run_id, accuracy: acc });
  expect(result.state).toBe("passed");
  expect(readLockTestManifest(tmp, "t1", m.run_id)!.state).toBe("passed");
});

it("finalizeLockTest sets state=failed when any primary criterion < 0.9", () => {
  fs.mkdirSync(path.join(tmp, "guidelines", "t1"), { recursive: true });
  const m = startLockTest({ rootDir: tmp, taskId: "t1", startedBy: "u", guidelineSha: "x" });
  const acc = {
    task_id: "t1", iter_id: m.run_id, cohort_kind: "lock" as const,
    patient_ids: ["p1"],
    per_criterion: [
      { field_id: "f1", n_evaluable: 1, n_correct: 1, accuracy: 1.0 },
      { field_id: "f2", n_evaluable: 1, n_correct: 0, accuracy: 0.86 },
    ],
    worst_accuracy: { field_id: "f2", accuracy: 0.86 },
    avg_accuracy: 0.93,
    override_count: 0,
    computed_at: "2026-05-02T00:00:00.000Z",
  };
  const result = finalizeLockTest({ rootDir: tmp, taskId: "t1", runId: m.run_id, accuracy: acc });
  expect(result.state).toBe("failed");
  expect(result.failure_reason).toMatch(/f2/);
});
```

- [ ] **Step 2: Run test (fails — `finalizeLockTest` missing)**

```bash
cd app && npx vitest run server/__tests__/lock-test.test.ts
```

- [ ] **Step 3: Implement `finalizeLockTest`**

Append to `app/server/lock-test.ts`:

```ts
import type { IterAccuracy } from "./iter-accuracy.js";
import { writeIterReport } from "./iter-accuracy.js";

const LOCK_THRESHOLD = 0.9;

export function finalizeLockTest(args: {
  rootDir: string;
  taskId: string;
  runId: string;
  accuracy: IterAccuracy;
}): LockTestManifest {
  const m = readLockTestManifest(args.rootDir, args.taskId, args.runId);
  if (!m) throw new Error(`no manifest for lock_test/${args.runId}`);

  // Persist the accuracy alongside the manifest.
  const dir = path.join(lockTestRunDir(args.rootDir, args.taskId, args.runId));
  fs.writeFileSync(path.join(dir, "accuracy.json"), JSON.stringify(args.accuracy, null, 2));

  // Reuse the per-iter report writer; it writes to <iter_id>/report.md, but
  // we point it at the lock_test/<run_id>/ dir by passing a custom layout.
  // For MVP, write the report inline:
  const lines: string[] = [
    `# Lock test ${args.runId} — ${args.taskId}`,
    "",
    `Cohort: LOCK · n=${args.accuracy.patient_ids.length}`,
    `Guideline sha: \`${m.guideline_sha}\``,
    `Copilot blind mode: ${m.copilot_blind_mode}`,
    `Started: ${m.started_at} by ${m.started_by}`,
    "",
    "## Per-criterion accuracy",
    "",
    "| criterion | n | accuracy |",
    "|-----------|---|----------|",
  ];
  for (const c of args.accuracy.per_criterion) {
    lines.push(`| \`${c.field_id}\` | ${c.n_evaluable} | ${c.accuracy?.toFixed(2) ?? "—"} |`);
  }
  lines.push("");

  const failing = args.accuracy.per_criterion.filter(
    (c) => c.accuracy == null || c.accuracy < LOCK_THRESHOLD,
  );
  const passed = failing.length === 0;
  const updated: LockTestManifest = {
    ...m,
    state: passed ? "passed" : "failed",
    completed_at: new Date().toISOString(),
    ...(passed ? {} : { failure_reason: `criteria below ${LOCK_THRESHOLD}: ${failing.map((c) => c.field_id).join(", ")}` }),
  };
  writeLockTestManifest(args.rootDir, args.taskId, updated);

  lines.push(`**Verdict:** ${passed ? "PASSED" : "FAILED"}`);
  if (!passed) lines.push(`Failing criteria: ${failing.map((c) => `\`${c.field_id}\``).join(", ")}`);
  fs.writeFileSync(path.join(dir, "report.md"), lines.join("\n") + "\n");

  // Suppress TS unused-import complaint if writeIterReport isn't used here.
  void writeIterReport;
  return updated;
}
```

- [ ] **Step 4: Maturity gate — modify `maturity.ts`**

In `app/server/maturity.ts`, find the `transitionMaturity` (or equivalent) function. Add a precondition for `calibrated → locked`:

```ts
import { listLockTests } from "./lock-test.js";
import { computeTaskSha } from "./lock.js";

// Inside transitionMaturity, before applying the transition:
if (from === "calibrated" && to === "locked") {
  const currentSha = await computeTaskSha(taskId);
  const passed = listLockTests(rootDir, taskId).some(
    (lt) => lt.state === "passed" && lt.guideline_sha === currentSha,
  );
  if (!passed) {
    throw new Error(
      `Cannot transition to locked: no passed lock test exists for current guideline sha ${currentSha.slice(0, 8)}.`,
    );
  }
}
```

- [ ] **Step 5: Add a maturity-gate test**

Path: `app/server/__tests__/lock-test.test.ts` (append)

```ts
import { transitionMaturity, readMaturity } from "../maturity.js";

it("blocks calibrated → locked when no lock test has passed for current sha", async () => {
  // Set up: maturity at calibrated, no lock_test/ dir.
  fs.mkdirSync(path.join(tmp, "guidelines", "t1"), { recursive: true });
  // Skipping setup of the full maturity record here — replace with existing test helper.
  // The test asserts the transition rejects with /no passed lock test/.
  // (See app/server/__tests__/methodologist.test.ts for maturity test setup pattern.)
});
```

(This test is a sketch — implement using the same helpers existing maturity tests use; consult `app/server/__tests__/methodologist.test.ts` for the pattern.)

- [ ] **Step 6: Run tests**

```bash
cd app && npx vitest run server/__tests__/lock-test.test.ts server/__tests__/methodologist.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add app/server/lock-test.ts app/server/maturity.ts app/server/__tests__/lock-test.test.ts
git commit -m "feat(server): finalize lock test + gate calibrated->locked on lock-test pass"
```

---

## Task 10: Lock test — server endpoints

**Files:**
- Modify: `app/server/server.ts`

Add three endpoints:

- `POST /api/lock-test/:taskId/start` — body: `{ started_by: string }`. Reads `sampling.json` to pick the LOCK cohort. Resolves the current `guideline_sha`. Calls `startLockTest`. Kicks off the agent batch-run on the LOCK cohort (reusing `startBatchRun` from `runs.ts`). Stores the resulting `run_id` in the manifest's `agent_run_id`.
- `GET /api/lock-test/:taskId` — returns `listLockTests(...)`.
- `POST /api/lock-test/:taskId/:runId/finalize` — called when the oracle finishes annotating. Computes accuracy on LOCK and calls `finalizeLockTest`.

- [ ] **Step 1: Implement the three endpoints**

In `app/server/server.ts`, after the existing pilots routes block:

```ts
import {
  startLockTest, finalizeLockTest, listLockTests, readLockTestManifest, writeLockTestManifest,
} from "./lock-test.js";

app.post("/api/lock-test/:taskId/start", async (req, res) => {
  const { taskId } = req.params;
  const startedBy = (req.body?.started_by as string) ?? "unknown";
  const cohort = readCohortSampling(PLATFORM_ROOT, taskId);
  if (!cohort || cohort.lock_patient_ids.length === 0) {
    return res.status(400).json({ error: "no_lock_cohort" });
  }
  const guidelineSha = await computeTaskSha(taskId);
  const m = startLockTest({ rootDir: PLATFORM_ROOT, taskId, startedBy, guidelineSha });

  // Start the agent batch run on the LOCK cohort. Reuse the existing runs helper.
  const run = await startBatchRun({ taskId, patientIds: cohort.lock_patient_ids });
  writeLockTestManifest(PLATFORM_ROOT, taskId, { ...m, agent_run_id: run.run_id });
  res.json({ run_id: m.run_id, agent_run_id: run.run_id });
});

app.get("/api/lock-test/:taskId", (req, res) => {
  res.json(listLockTests(PLATFORM_ROOT, req.params.taskId));
});

app.post("/api/lock-test/:taskId/:runId/finalize", (req, res) => {
  const { taskId, runId } = req.params;
  const m = readLockTestManifest(PLATFORM_ROOT, taskId, runId);
  if (!m) return res.status(404).json({ error: "no_lock_test_run" });
  const cohort = readCohortSampling(PLATFORM_ROOT, taskId);
  if (!cohort) return res.status(400).json({ error: "no_cohort" });
  const primaryCriterionIds = readPrimaryCriterionIds(PLATFORM_ROOT, taskId);
  const accuracy = computeIterAccuracy({
    rootDir: PLATFORM_ROOT,
    taskId,
    iterId: runId,
    cohortKind: "lock",
    patientIds: cohort.lock_patient_ids,
    primaryCriterionIds,
  });
  const updated = finalizeLockTest({ rootDir: PLATFORM_ROOT, taskId, runId, accuracy });
  res.json({ manifest: updated, accuracy });
});
```

- [ ] **Step 2: Smoke test the routes manually**

Restart dev server. With a known task that has a `sampling.json`:

```bash
curl -X POST http://localhost:3001/api/lock-test/lung-cancer-phenotype/start \
  -H "Content-Type: application/json" -d '{"started_by":"test_pi"}'
```

Confirm the response contains `run_id`. Then `GET /api/lock-test/lung-cancer-phenotype` returns the run.

- [ ] **Step 3: Commit**

```bash
git add app/server/server.ts
git commit -m "feat(server): /api/lock-test/:taskId start|list|finalize endpoints"
```

---

## Task 11: review-copilot blind_mode flag

**Files:**
- Modify: the review-copilot system-prompt builder. Find it via:

```bash
grep -rn "review-copilot\|review_copilot" app/server/ --include="*.ts" | head -20
```

- Modify: the chat endpoint that injects the system prompt (look for the route that calls the copilot).

The flag's effect: when `blind_mode === true`, the system prompt MUST NOT include the "explain agent rationale" mode and MUST refuse to disclose the agent's draft answer.

- [ ] **Step 1: Locate the copilot system prompt**

```bash
cd app && grep -rn "you are a review copilot" server/ --include="*.ts" -i
grep -rn "explain agent rationale\|why did the agent" server/ --include="*.ts" -i
```

Expected: a string template in either `app/server/skills/` or `app/server/` building the copilot's system prompt.

- [ ] **Step 2: Add a `blindMode` parameter**

Modify the system prompt builder to take `blindMode: boolean`. When true:
- Remove (or replace) the section that discusses the "Explain — why did the drafting agent pick the value it picked?" mode.
- Add a hard rule: "Do not disclose the agent's draft answer or its rationale. The reviewer must form an independent judgment."

- [ ] **Step 3: Plumb the flag through the chat endpoint**

Find the route handler that creates the chat session (likely something like `POST /api/chat` or `POST /api/copilot/...`). Accept `blind_mode?: boolean` in the request body and pass it through.

- [ ] **Step 4: Add a unit test**

A small test that invokes the system-prompt builder with `blindMode: true` and asserts the output does NOT contain "explain" / "why did the agent" phrasing.

- [ ] **Step 5: Run tests**

```bash
cd app && npx vitest run server/__tests__/
```

- [ ] **Step 6: Commit**

```bash
git add app/server/...
git commit -m "feat(server): review-copilot blind_mode flag for lock-test annotation"
```

---

## Task 12: Client — extract PilotsTab into its own directory

This is a **mechanical refactor** before adding new components. Move the inline `PilotsFigure` + `PilotListing` interface out of `Studio.tsx` so each new file can be small and focused.

**Files:**
- Create: `app/client/src/v2/PilotsTab/index.tsx`
- Create: `app/client/src/v2/PilotsTab/types.ts`
- Modify: `app/client/src/v2/Studio.tsx`

- [ ] **Step 1: Create `types.ts`**

Path: `app/client/src/v2/PilotsTab/types.ts`

Move the `PilotListing` interface from `Studio.tsx` here, and add the new `accuracy_summary` field:

```ts
export interface PilotListing {
  iter_id: string;
  iter_num: number;
  state: string;
  run_status: string | null;
  n_complete: number;
  n_patients: number;
  notes?: string;
  started_at: string;
  started_by: string;
  critique?: { ran_at: string; proposal_count: number; error?: string } | null;
  auto_critique_state?: "running" | "failed";
  accuracy_summary?: {
    worst: { field_id: string; accuracy: number } | null;
    avg: number | null;
    override_count: number;
  } | null;
}

export interface EligibilityResult {
  eligible: boolean;
  consecutive_passing: number;
  required_consecutive: number;
  failing_criteria: Array<{ field_id: string; accuracy: number | null; iter_id: string }>;
  override_growth: number;
}
```

- [ ] **Step 2: Create `index.tsx`** that re-exports the existing `PilotsFigure`

Path: `app/client/src/v2/PilotsTab/index.tsx`

Move the body of `function PilotsFigure(...)` and `function PilotRow(...)` out of `Studio.tsx` into this file. Update imports (the `authFetch`, `Badge`, `Separator`, `cn`, lucide icons stay the same — paths shift by one level so use the same `../auth`, `@/components/...`, etc.).

Also export the helper components `FigurePage`, `FigureStats`, `Stat`, `EmptyHint` from `Studio.tsx` (or move them to a shared `app/client/src/v2/figure-primitives.tsx`). For minimum scope: move them to `figure-primitives.tsx` and import from both `Studio.tsx` and `PilotsTab/index.tsx`.

- [ ] **Step 3: Update `Studio.tsx`**

Replace the inline `PilotsFigure` + `PilotRow` with:

```tsx
import { PilotsFigure } from "./PilotsTab";
```

Delete the now-dead `PilotListing` interface and the inline `PilotsFigure` / `PilotRow` definitions.

- [ ] **Step 4: Run typecheck + dev server smoke**

```bash
cd app && npx tsc --noEmit
npm run dev   # in another terminal; visit http://localhost:5173, navigate to Studio → Pilots, confirm renders identical
```

- [ ] **Step 5: Commit**

```bash
git add app/client/src/v2/PilotsTab/ app/client/src/v2/Studio.tsx app/client/src/v2/figure-primitives.tsx
git commit -m "refactor(client): extract Studio Pilots tab into PilotsTab/ module"
```

---

## Task 13: Client — accuracy mini-strip on each iter row

**Files:**
- Modify: `app/client/src/v2/PilotsTab/index.tsx` (the `PilotRow` component)

Per the mock (state 1, the compact iter list at the bottom), each row gets a single number pair: `0.70 / 0.86` ("worst / avg"). Plus a small bar visual when expanded.

- [ ] **Step 1: Update `PilotRow` to render the accuracy strip**

Inside `PilotRow`, after the existing `<div className="mt-1 text-[12.5px] text-muted-foreground">…</div>` line, add:

```tsx
{p.accuracy_summary && (
  <div className="mt-1 flex items-center gap-2 text-[11.5px] tabular-nums">
    <span className={cn(
      "font-mono",
      p.accuracy_summary.worst && p.accuracy_summary.worst.accuracy < 0.9
        ? "text-[hsl(var(--oxblood))]"
        : "text-foreground",
    )}>
      {p.accuracy_summary.worst ? p.accuracy_summary.worst.accuracy.toFixed(2) : "—"}
    </span>
    <span className="text-muted-foreground/50">/</span>
    <span className="font-mono text-muted-foreground">
      {p.accuracy_summary.avg != null ? p.accuracy_summary.avg.toFixed(2) : "—"}
    </span>
    <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">worst · avg</span>
  </div>
)}
```

- [ ] **Step 2: Visual smoke**

Run the dev server, navigate to Studio → Pilots. For any iter that already has a critique.json with the new `accuracy` field (will be empty until the next critique runs), the strip should appear; for legacy iters without it, the row renders unchanged.

- [ ] **Step 3: Commit**

```bash
git add app/client/src/v2/PilotsTab/index.tsx
git commit -m "feat(client): per-iter accuracy mini-strip on PilotRow"
```

---

## Task 14: Client — eligibility pip + lock-test CTA

**Files:**
- Create: `app/client/src/v2/PilotsTab/EligibilityPip.tsx`
- Modify: `app/client/src/v2/PilotsTab/index.tsx` (fetch + render eligibility above the iter list)

- [ ] **Step 1: Create `EligibilityPip.tsx`**

Path: `app/client/src/v2/PilotsTab/EligibilityPip.tsx`

```tsx
import type { EligibilityResult } from "./types";

export function EligibilityPip({ eligibility }: { eligibility: EligibilityResult }) {
  const dots: JSX.Element[] = [];
  for (let i = 0; i < eligibility.required_consecutive; i++) {
    const filled = i < eligibility.consecutive_passing;
    dots.push(
      <span
        key={i}
        aria-hidden
        className={
          filled
            ? "block h-2.5 w-2.5 rounded-full bg-[hsl(var(--sage))]"
            : "block h-2.5 w-2.5 rounded-full border border-border bg-paper"
        }
      />
    );
  }
  return (
    <div className="flex items-center justify-center gap-3 text-[12px] text-muted-foreground">
      <span className="text-[10px] uppercase tracking-[0.18em]">Lock-test eligibility</span>
      <span className="inline-flex items-center gap-1.5">{dots}</span>
      <span className="font-mono">
        {eligibility.consecutive_passing} of {eligibility.required_consecutive} consecutive iters
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Fetch eligibility in `PilotsFigure` and render**

In `PilotsTab/index.tsx`, add another `useEffect` to fetch `/api/pilots/${taskId}/eligibility`, store result in state. Render `<EligibilityPip eligibility={result} />` between the stats row and the iter list.

When `eligibility.eligible === true`, render a primary CTA button:

```tsx
{eligibility?.eligible && (
  <div className="mt-4 flex justify-center">
    <Button onClick={() => setLockModalOpen(true)} variant="default" size="sm">
      Run lock test
    </Button>
  </div>
)}
```

- [ ] **Step 3: Add a component test**

Path: `app/client/src/v2/__tests__/eligibility-ui.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EligibilityPip } from "../PilotsTab/EligibilityPip";

describe("EligibilityPip", () => {
  it("renders 1 of 2 when one consecutive passing", () => {
    render(
      <EligibilityPip
        eligibility={{
          eligible: false, consecutive_passing: 1, required_consecutive: 2,
          failing_criteria: [], override_growth: 0,
        }}
      />
    );
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run client tests**

```bash
cd app && npx vitest run client/src/__tests__/
```

- [ ] **Step 5: Commit**

```bash
git add app/client/src/v2/PilotsTab/EligibilityPip.tsx app/client/src/v2/PilotsTab/index.tsx app/client/src/v2/__tests__/eligibility-ui.test.tsx
git commit -m "feat(client): eligibility pip + run-lock-test CTA above iter list"
```

---

## Task 15: Client — trajectory chart

**Files:**
- Create: `app/client/src/v2/PilotsTab/TrajectoryChart.tsx`
- Modify: `app/client/src/v2/PilotsTab/index.tsx` (render above the iter list when ≥2 iters with accuracy)

Per the mock (state 1, visual central): SVG line chart, eight thin sage lines (one per primary criterion), one bold oxblood line for the worst-criterion-across-iters, dashed threshold line at 0.90.

- [ ] **Step 1: Implement `TrajectoryChart.tsx`**

Path: `app/client/src/v2/PilotsTab/TrajectoryChart.tsx`

```tsx
interface IterAccuracyShape {
  iter_id: string;
  per_criterion: Array<{ field_id: string; accuracy: number | null }>;
  worst_accuracy: { field_id: string; accuracy: number } | null;
}

export function TrajectoryChart({ iters }: { iters: IterAccuracyShape[] }) {
  if (iters.length < 2) return null;

  const fieldIds = Array.from(
    new Set(iters.flatMap((it) => it.per_criterion.map((c) => c.field_id)))
  ).sort();

  // Pick the worst field overall (across iters) for the bold oxblood line.
  let worstField = fieldIds[0];
  let worstSeen = 1.0;
  for (const it of iters) {
    if (it.worst_accuracy && it.worst_accuracy.accuracy < worstSeen) {
      worstSeen = it.worst_accuracy.accuracy;
      worstField = it.worst_accuracy.field_id;
    }
  }

  const PAD_X = 80, PAD_R = 30, W = 720, H = 320, PLOT_TOP = 33, PLOT_BOTTOM = 260;
  const xFor = (i: number) => PAD_X + (i * (W - PAD_X - PAD_R)) / Math.max(1, iters.length - 1);
  // y maps accuracy [0.5, 1.0] → [PLOT_BOTTOM, PLOT_TOP].
  const yFor = (acc: number) => {
    const clamped = Math.max(0.5, Math.min(1.0, acc));
    return PLOT_BOTTOM - ((clamped - 0.5) / 0.5) * (PLOT_BOTTOM - PLOT_TOP);
  };
  const yThreshold = yFor(0.9);

  const polylineFor = (fid: string) =>
    iters
      .map((it, i) => {
        const c = it.per_criterion.find((c) => c.field_id === fid);
        if (!c || c.accuracy == null) return null;
        return `${xFor(i)},${yFor(c.accuracy)}`;
      })
      .filter(Boolean)
      .join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Per-criterion accuracy trajectory">
      <line x1={PAD_X} y1={yThreshold} x2={W - PAD_R} y2={yThreshold}
        stroke="hsl(var(--oxblood))" strokeWidth="1.25" strokeDasharray="6 3" opacity="0.6"/>
      <text x={W - PAD_R + 4} y={yThreshold + 3} fontFamily="IBM Plex Mono" fontSize="10" fill="hsl(var(--oxblood))">threshold</text>

      {/* Background: every non-worst criterion in faded sage */}
      <g stroke="hsl(var(--sage))" strokeOpacity="0.22" strokeWidth="1.25" fill="none">
        {fieldIds.filter((f) => f !== worstField).map((fid) => (
          <polyline key={fid} points={polylineFor(fid)} />
        ))}
      </g>

      {/* Worst criterion in oxblood */}
      <polyline
        points={polylineFor(worstField)}
        stroke="hsl(var(--oxblood))" strokeWidth="2.25" fill="none" strokeLinejoin="round" strokeLinecap="round"
      />
      {iters.map((it, i) => {
        const c = it.per_criterion.find((c) => c.field_id === worstField);
        if (!c || c.accuracy == null) return null;
        return <circle key={it.iter_id} cx={xFor(i)} cy={yFor(c.accuracy)} r={i === iters.length - 1 ? 4 : 3} fill="hsl(var(--oxblood))"/>;
      })}

      {/* X-axis labels */}
      {iters.map((it, i) => (
        <text key={it.iter_id} x={xFor(i)} y={H - 40} fontFamily="IBM Plex Mono" fontSize="10" fill="hsl(var(--muted-foreground))" textAnchor="middle">
          {it.iter_id.replace("iter_", "iter ")}
        </text>
      ))}

      {/* Y-axis labels */}
      <line x1={PAD_X} y1={PLOT_TOP} x2={PAD_X} y2={PLOT_BOTTOM} stroke="hsl(var(--ink))" strokeWidth="1"/>
      {[1.0, 0.9, 0.8, 0.7, 0.6, 0.5].map((v) => (
        <text key={v} x={PAD_X - 8} y={yFor(v) + 3} fontFamily="IBM Plex Mono" fontSize="10" fill="hsl(var(--muted-foreground))" textAnchor="end">{v.toFixed(2)}</text>
      ))}
    </svg>
  );
}
```

- [ ] **Step 2: Render in `PilotsFigure`**

In `PilotsTab/index.tsx`, fetch each completed pilot's accuracy block (already on the listing as `accuracy_summary` plus full `critique.accuracy` if needed) and pass to `<TrajectoryChart iters={…} />` between the lede and the eligibility pip.

(Note: `accuracy_summary` is the lightweight summary; for the chart we need the full `per_criterion` from `critique.accuracy`. Add an additional fetch endpoint or include the full `accuracy` block in the listing response — choose whichever keeps the code smaller; for MVP, include `accuracy: critique.accuracy` in the listing payload from `pilots.ts`.)

- [ ] **Step 3: Visual smoke**

Run dev server. Navigate to Studio → Pilots. Verify chart renders for the lung-cancer task once the first iter critique with accuracy lands.

- [ ] **Step 4: Commit**

```bash
git add app/client/src/v2/PilotsTab/TrajectoryChart.tsx app/client/src/v2/PilotsTab/index.tsx app/server/pilots.ts
git commit -m "feat(client): trajectory chart as Pilots-tab visual central"
```

---

## Task 16: Client — expanded iter detail panel (drill-in)

**Files:**
- Create: `app/client/src/v2/PilotsTab/IterDetail.tsx`
- Modify: `app/client/src/v2/PilotsTab/index.tsx` (render `<IterDetail/>` when an iter row is expanded)

Detail panel content (per spec §3.0 and mock state 1's expanded row):
1. Patient validation progress chips (10 chips, status per patient).
2. Per-criterion accuracy table.
3. Override clusters with proposal links (link out to existing Rules tab).

- [ ] **Step 1: Implement `IterDetail.tsx`**

Path: `app/client/src/v2/PilotsTab/IterDetail.tsx`

```tsx
import { useEffect, useState } from "react";
import { authFetch } from "../../auth";
import type { PilotListing } from "./types";

interface IterAccuracy {
  per_criterion: Array<{ field_id: string; n_evaluable: number; n_correct: number; accuracy: number | null }>;
  override_count: number;
}

interface PatientStatus {
  patient_id: string;
  agent_done: boolean;
  oracle_done: boolean;
  in_progress: boolean;
}

export function IterDetail({ taskId, p }: { taskId: string; p: PilotListing }) {
  const [accuracy, setAccuracy] = useState<IterAccuracy | null>(null);
  const [patients, setPatients] = useState<PatientStatus[]>([]);

  useEffect(() => {
    authFetch(`/api/pilots/${taskId}/${p.iter_id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setAccuracy(d?.critique?.accuracy ?? null);
        setPatients(d?.patient_status ?? []);
      });
  }, [taskId, p.iter_id]);

  return (
    <div className="grid grid-cols-12 gap-x-8 gap-y-6 px-5 py-6 border-t border-border/50 bg-paper/30">
      {/* Patient progress */}
      <div className="col-span-12">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
          Validation progress · DEV cohort (n={patients.length})
        </div>
        <div className="grid grid-cols-5 gap-2">
          {patients.map((ps) => (
            <PatientChip key={ps.patient_id} ps={ps} />
          ))}
        </div>
      </div>

      {/* Accuracy table */}
      {accuracy && (
        <div className="col-span-7">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Per-criterion accuracy
          </div>
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <th className="border-b border-border py-2 pr-3">Criterion</th>
                <th className="border-b border-border py-2 pr-3 text-right">n</th>
                <th className="border-b border-border py-2 pr-3 text-right">accuracy</th>
              </tr>
            </thead>
            <tbody>
              {accuracy.per_criterion.map((c) => (
                <tr key={c.field_id} className="border-b border-border/40">
                  <td className="py-2 pr-3 font-mono text-[12px]">{c.field_id}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{c.n_evaluable}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.accuracy == null ? "—" : c.accuracy.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Override count + Rules link */}
      {accuracy && (
        <div className="col-span-5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-3">Overrides</div>
          <div className="font-display text-[34px] tabular-nums" style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}>
            {accuracy.override_count}
          </div>
          <a className="mt-3 inline-block text-[11.5px] text-[hsl(var(--oxblood))] underline-offset-2 hover:underline" href="#rules">
            Review proposals in Rules tab →
          </a>
        </div>
      )}
    </div>
  );
}

function PatientChip({ ps }: { ps: PatientStatus }) {
  const dot = ps.oracle_done
    ? "bg-[hsl(var(--sage))]"
    : ps.in_progress
    ? "bg-[hsl(var(--oxblood))] ring-4 ring-[hsl(var(--oxblood)/0.18)]"
    : ps.agent_done
    ? "bg-[hsl(var(--ochre))]"
    : "bg-border";
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-mono">
      <span className={`block h-1.5 w-1.5 rounded-full ${dot}`}></span>
      {ps.patient_id}
    </div>
  );
}
```

- [ ] **Step 2: Add `patient_status` to the `/api/pilots/:taskId/:iterId` response**

In `app/server/pilots.ts`, the existing detail endpoint already reads the run manifest. Extend its response to include `patient_status: PatientStatus[]` derived from:
- For each `dev_patient_ids` in `sampling.json`:
  - `agent_done` = run manifest's per-patient draft state is `complete`.
  - `oracle_done` = `reviews/<pid>/<task_id>/review_state.json` has `review_status === "reviewer_validated"` or `locked`.
  - `in_progress` = oracle has touched at least one assessment (any `source: "reviewer"` field) but `review_status` is not validated.

- [ ] **Step 3: Wire expansion into `PilotsTab/index.tsx`**

Track `expandedIterId` in state. On row click, toggle. When expanded, render `<IterDetail taskId={taskId} p={p}/>` directly under the row.

- [ ] **Step 4: Visual smoke**

Click an iter row in the dev server; expand should show the detail panel.

- [ ] **Step 5: Commit**

```bash
git add app/client/src/v2/PilotsTab/IterDetail.tsx app/client/src/v2/PilotsTab/index.tsx app/server/pilots.ts
git commit -m "feat(client): expanded iter detail panel with patient progress + accuracy table"
```

---

## Task 17: Client — Lock-test row + patient grid + verdict block

**Files:**
- Create: `app/client/src/v2/PilotsTab/LockTestRow.tsx`
- Create: `app/client/src/v2/PilotsTab/LockTestPatientGrid.tsx`
- Modify: `app/client/src/v2/PilotsTab/index.tsx` (fetch `/api/lock-test/:taskId`, render the latest run as a distinct row at the top of the iter list)

Per the mock (state 2): visually distinct row with `L<n>` hero number and an oxblood border, expanded body shows the 30-cell patient grid and per-criterion verdict cards.

- [ ] **Step 1: Implement `LockTestPatientGrid.tsx`**

```tsx
interface LockPatientStatus {
  patient_id: string;
  oracle_done: boolean;
  in_progress: boolean;
}

export function LockTestPatientGrid({ patients }: { patients: LockPatientStatus[] }) {
  const done = patients.filter((p) => p.oracle_done).length;
  const inProgress = patients.filter((p) => p.in_progress).length;
  const pending = patients.length - done - inProgress;
  return (
    <div className="mx-auto" style={{ maxWidth: 540 }}>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
        {patients.map((p) => {
          const cls = p.oracle_done
            ? "aspect-square rounded-md bg-[hsl(var(--sage)/0.85)]"
            : p.in_progress
            ? "aspect-square rounded-md bg-[hsl(var(--oxblood))] ring-4 ring-[hsl(var(--oxblood)/0.20)]"
            : "aspect-square rounded-md border border-border bg-paper";
          return <div key={p.patient_id} className={cls} title={p.patient_id} />;
        })}
      </div>
      <div className="mt-5 grid grid-cols-3 gap-4 text-center">
        <Stat n={done} label="Validated" tone="sage" />
        <Stat n={inProgress} label="In progress" tone="oxblood" />
        <Stat n={pending} label="Pending" tone="mute" />
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: "sage" | "oxblood" | "mute" }) {
  const colorCls =
    tone === "sage" ? "text-[hsl(var(--sage))]" :
    tone === "oxblood" ? "text-[hsl(var(--oxblood))]" :
    "text-muted-foreground";
  return (
    <div>
      <div className={`font-display text-[28px] leading-none tabular-nums ${colorCls}`} style={{ fontVariationSettings: '"opsz" 30, "SOFT" 50' }}>{n}</div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mt-1">{label}</div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `LockTestRow.tsx`** — row + expand → grid + per-criterion verdict cards + finalize button

```tsx
import { useEffect, useState } from "react";
import { authFetch } from "../../auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LockTestPatientGrid } from "./LockTestPatientGrid";

interface LockTestManifest {
  run_id: string; state: string; started_at: string; started_by: string;
  guideline_sha: string; copilot_blind_mode: true; failure_reason?: string;
}
interface LockTestDetail {
  manifest: LockTestManifest;
  patients: Array<{ patient_id: string; oracle_done: boolean; in_progress: boolean }>;
  accuracy?: { per_criterion: Array<{ field_id: string; accuracy: number | null }> };
}

export function LockTestRow({ taskId, m, onChange }: { taskId: string; m: LockTestManifest; onChange: () => void }) {
  const [open, setOpen] = useState(true); // open by default — it's the focal item when present
  const [detail, setDetail] = useState<LockTestDetail | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    authFetch(`/api/lock-test/${taskId}/${m.run_id}/detail`).then((r) => (r.ok ? r.json() : null)).then(setDetail);
  }, [taskId, m.run_id]);

  async function finalize() {
    setBusy(true);
    try {
      await authFetch(`/api/lock-test/${taskId}/${m.run_id}/finalize`, { method: "POST" });
      onChange();
    } finally { setBusy(false); }
  }

  return (
    <li className="rounded-md overflow-hidden border border-[hsl(var(--oxblood)/0.40)]" style={{ background: "linear-gradient(180deg, hsl(var(--oxblood) / 0.04), hsl(var(--card)) 64px)" }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left grid grid-cols-[60px_1fr_auto] items-baseline gap-6 px-5 pt-4 pb-3 border-b border-border/50">
        <div className="font-display text-[26px] tabular-nums text-[hsl(var(--oxblood))]" style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}>L1</div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[12.5px]">{m.run_id}</span>
            <Badge variant={m.state === "running" ? "primary" : m.state === "passed" ? "validated" : m.state === "failed" ? "destructive" : "outline"} className="!text-[10px]">
              {m.state}
            </Badge>
            <Badge variant="primary" className="!text-[10px]">LOCK · n=30</Badge>
          </div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">started {m.started_at.slice(0, 16)} · {m.started_by} · sha <span className="font-mono">{m.guideline_sha.slice(0, 8)}</span> · copilot mode <span className="font-mono text-[hsl(var(--ochre))]">blind</span></div>
          {m.failure_reason && <div className="mt-1 text-[12px] text-[hsl(var(--oxblood))]">{m.failure_reason}</div>}
        </div>
      </button>
      {open && detail && (
        <div className="px-5 py-6 space-y-6">
          <LockTestPatientGrid patients={detail.patients} />
          {detail.accuracy && (
            <div className="grid grid-cols-4 gap-3">
              {detail.accuracy.per_criterion.map((c) => (
                <div key={c.field_id} className="rounded-md border border-border bg-card px-3 py-2.5">
                  <div className="text-[10.5px] text-muted-foreground font-mono">{c.field_id}</div>
                  <div className="mt-0.5 font-display text-[20px] tabular-nums" style={{ fontVariationSettings: '"opsz" 24, "SOFT" 50' }}>
                    {c.accuracy == null ? "—" : c.accuracy.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {m.state === "running" && (
            <Button onClick={finalize} disabled={busy} variant="default" size="sm">
              {busy ? "finalizing…" : "Finalize lock test"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
```

- [ ] **Step 3: Add `/api/lock-test/:taskId/:runId/detail` endpoint**

In `app/server/server.ts`, add a route that returns `{ manifest, patients, accuracy }`. Compute `patients` the same way as Task 16 step 2 but for the LOCK cohort.

- [ ] **Step 4: Render `LockTestRow` in `PilotsTab`**

In `PilotsTab/index.tsx`, fetch `/api/lock-test/:taskId`. If the newest run exists, render `<LockTestRow ... />` at the top of the iter list, ahead of the regular iter rows.

- [ ] **Step 5: Smoke**

Run dev. Trigger lock test via curl (Task 10). Confirm row + grid render. Click Finalize, confirm state transitions to passed/failed.

- [ ] **Step 6: Commit**

```bash
git add app/client/src/v2/PilotsTab/LockTestRow.tsx app/client/src/v2/PilotsTab/LockTestPatientGrid.tsx app/client/src/v2/PilotsTab/index.tsx app/server/server.ts
git commit -m "feat(client): lock-test row with patient grid + finalize action"
```

---

## Task 18: Client — Cohort curation modal

**Files:**
- Create: `app/client/src/v2/PilotsTab/CohortCurationModal.tsx`
- Modify: `app/client/src/v2/PilotsTab/index.tsx` (open modal from a "Curate cohorts" button when no `sampling.json` exists)

The modal has two columns: DEV (10 patients) and LOCK (30 patients). For MVP: show a list of all corpus patients; user clicks to add to one column or the other. Validate: no overlap, sizes match defaults (warn if off).

- [ ] **Step 1: Implement the modal**

Path: `app/client/src/v2/PilotsTab/CohortCurationModal.tsx`

```tsx
import { useEffect, useState } from "react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";

export function CohortCurationModal({ taskId, onClose, onSaved }: { taskId: string; onClose: () => void; onSaved: () => void }) {
  const [allPatients, setAllPatients] = useState<string[]>([]);
  const [dev, setDev] = useState<string[]>([]);
  const [lock, setLock] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    authFetch("/api/patients").then((r) => r.json()).then((rows: any[]) => setAllPatients(rows.map((r) => r.patient_id)));
  }, []);

  function addTo(target: "dev" | "lock", id: string) {
    if (target === "dev") setDev([...dev, id]);
    else setLock([...lock, id]);
  }
  function remove(id: string) {
    setDev(dev.filter((x) => x !== id));
    setLock(lock.filter((x) => x !== id));
  }
  function poolFiltered() {
    const used = new Set([...dev, ...lock]);
    return allPatients.filter((p) => !used.has(p));
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/cohort-sampling/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          version: 1,
          created_at: new Date().toISOString(),
          created_by: "test_pi",
          dev_patient_ids: dev,
          lock_patient_ids: lock,
        }),
      });
      if (!r.ok) {
        const body = await r.json();
        setErr(body.error ?? `error ${r.status}`);
        return;
      }
      onSaved();
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[960px] max-h-[80vh] overflow-auto rounded-lg border border-border bg-paper p-6 shadow-xl">
        <h3 className="font-display text-[22px]" style={{ fontVariationSettings: '"opsz" 26, "SOFT" 50' }}>Curate cohorts</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">Pick 10 dev + 30 lock patients. No overlap. Stratify to cover ≥1 positive, ≥1 negative, ≥1 edge per primary criterion.</p>
        <div className="mt-5 grid grid-cols-3 gap-6">
          <Pool label={`Pool (${poolFiltered().length})`} ids={poolFiltered()} actions={[
            { label: "→ DEV", run: (id) => addTo("dev", id) },
            { label: "→ LOCK", run: (id) => addTo("lock", id) },
          ]}/>
          <Pool label={`DEV (${dev.length}/10)`} ids={dev} actions={[{ label: "remove", run: remove }]}/>
          <Pool label={`LOCK (${lock.length}/30)`} ids={lock} actions={[{ label: "remove", run: remove }]}/>
        </div>
        {err && <div className="mt-4 text-[12px] text-[hsl(var(--oxblood))]">{err}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="default" onClick={save} disabled={busy || dev.length === 0 || lock.length === 0}>
            {busy ? "saving…" : "Save sampling.json"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Pool({ label, ids, actions }: { label: string; ids: string[]; actions: Array<{ label: string; run: (id: string) => void }> }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">{label}</div>
      <ul className="space-y-1 max-h-[420px] overflow-auto pr-1">
        {ids.map((id) => (
          <li key={id} className="flex items-center justify-between rounded-md border border-border bg-card px-2 py-1 text-[12px]">
            <span className="font-mono">{id}</span>
            <span className="flex gap-1">
              {actions.map((a) => (
                <button key={a.label} onClick={() => a.run(id)} className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground">
                  {a.label}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Wire the modal into `PilotsTab/index.tsx`**

Show a "Curate cohorts" button when `cohort` (fetched from `/api/cohort-sampling/:taskId`) is `null`. On click, open the modal.

- [ ] **Step 3: Smoke**

For a guideline without a `sampling.json`, the button should appear; opening the modal lets you build a cohort and save it.

- [ ] **Step 4: Commit**

```bash
git add app/client/src/v2/PilotsTab/CohortCurationModal.tsx app/client/src/v2/PilotsTab/index.tsx
git commit -m "feat(client): cohort curation modal — pick DEV + LOCK patients, save sampling.json"
```

---

## Task 19: Client — Authoring → Pilots handoff card

**Files:**
- Create: `app/client/src/v2/PilotsTab/AuthoringHandoffCard.tsx`
- Modify: `app/client/src/v2/PilotsTab/index.tsx` (render the card when zero pilot iters AND a cohort is missing)

Per mock state 3 — single hero card centered with the seal, task ID, criterion count, sha, single CTA "Curate cohorts".

- [ ] **Step 1: Implement the card**

Path: `app/client/src/v2/PilotsTab/AuthoringHandoffCard.tsx`

```tsx
import { Button } from "@/components/ui/button";

export function AuthoringHandoffCard({
  taskId, criterionCount, guidelineSha, onCurate,
}: {
  taskId: string; criterionCount: number; guidelineSha: string; onCurate: () => void;
}) {
  return (
    <div className="mx-auto my-8" style={{ maxWidth: 520 }}>
      <div className="rounded-lg border border-[hsl(var(--oxblood)/0.25)] bg-card px-8 py-9 text-center" style={{ boxShadow: "0 1px 0 hsl(var(--oxblood) / 0.10), 0 12px 32px -16px hsl(var(--oxblood) / 0.18)" }}>
        <span className="seal mx-auto" style={{ width: "1.6rem", height: "1.6rem", fontSize: "0.85rem" }} aria-hidden>R</span>
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mt-5">{taskId}</div>
        <div className="mt-2 font-display text-[24px] leading-tight" style={{ fontVariationSettings: '"opsz" 28, "SOFT" 50' }}>
          {criterionCount} criteria · sha <span className="font-mono text-[19px]">{guidelineSha.slice(0, 8)}</span>
        </div>
        <p className="mt-3 text-[13px] text-muted-foreground max-w-[40ch] mx-auto">
          Pick 10 dev + 30 lock patients, stratified to cover at least one positive, one negative, and one edge case per primary criterion.
        </p>
        <Button onClick={onCurate} variant="default" size="default" className="mt-7">
          Curate cohorts →
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render in PilotsFigure when conditions match**

In `PilotsTab/index.tsx`:

```tsx
{pilots.length === 0 && !cohort && (
  <AuthoringHandoffCard
    taskId={taskId}
    criterionCount={criterionCount}
    guidelineSha={guidelineSha}
    onCurate={() => setCohortModalOpen(true)}
  />
)}
```

(Fetch `criterionCount` from the existing task metadata endpoint — likely `/api/tasks/:taskId` or similar; check `Studio.tsx` for the existing pattern.)

- [ ] **Step 3: Smoke**

For a guideline with no pilot iters and no sampling.json, the handoff card should appear; clicking opens the curation modal.

- [ ] **Step 4: Commit**

```bash
git add app/client/src/v2/PilotsTab/AuthoringHandoffCard.tsx app/client/src/v2/PilotsTab/index.tsx
git commit -m "feat(client): authoring->pilots handoff hero card"
```

---

## Task 20: E2E — extend the suite

**Files:**
- Modify: `app/e2e/vibe-chart-review.spec.ts`

Add new tests **at the bottom of the existing `test.describe` block**, numbered after the last existing test. The suite is sequential (`workers: 1`); each test depends on prior state. Reuse the `TASK_ID` and `loginViaApi` helpers already defined.

New tests to add:

1. **Cohort curation** — open the curation modal, build a tiny cohort (1 dev, 1 lock for speed), save. Confirm `/api/cohort-sampling/:taskId` returns 200.
2. **Per-iter accuracy after critique** — POST `/api/pilots/:taskId/:iterId/critique` for the existing test 5 iter; GET `/api/pilots/:taskId`; assert the listing item has `accuracy_summary` populated.
3. **Eligibility endpoint** — GET `/api/pilots/:taskId/eligibility`; assert it returns `{ eligible: false, consecutive_passing: 1, required_consecutive: 2 }` (only one passing iter so far).
4. **Lock-test start + finalize** — POST `/api/lock-test/:taskId/start`. Wait until the agent_run completes. POST finalize. Assert manifest state is `passed` or `failed`. If passed, attempt the maturity transition `calibrated → locked` via the existing API and assert it succeeds.

For tests that hit the agent (the lock-test start), use a 1-patient lock cohort so the e2e cost stays bounded (~$0.05 incremental). The existing test 5 already proves the agent run wiring works; here we only verify the *additional* lock-test wiring.

- [ ] **Step 1: Sketch the new tests**

Add ~80 lines after the last existing test. Each test follows the existing pattern (`test("N. description", async ({ page, request }) => { ... })`).

- [ ] **Step 2: Run the e2e suite**

```bash
cd app && npx playwright test e2e/vibe-chart-review.spec.ts
```

Expected: 15 (existing) + 4 (new) = 19 tests pass. Total cost ~$0.50–0.55. Total runtime ~7 min.

- [ ] **Step 3: Commit**

```bash
git add app/e2e/vibe-chart-review.spec.ts
git commit -m "test(e2e): cover cohort curation, eligibility, and lock test wiring"
```

---

## Self-Review Checklist (already applied)

**Spec coverage:**
- §3.0 Studio→Pilots placement → Tasks 12, 13, 14, 16, 17, 18, 19
- §3.1 Cohorts (sampling.json) → Tasks 1, 2, 18
- §3.2 Three agent roles unchanged → no work needed (existing skills used as-is)
- §3.3 Maturity transitions, calibrated→locked gate → Task 9 step 4
- §4 Iteration loop → reuses existing critique endpoint; Task 5 wires accuracy compute into it
- §5 Stopping criteria → Tasks 6, 7, 14 (eligibility pip)
- §6 Lock test (the gate) → Tasks 8, 9, 10, 17, 20
- §7 Reports (per-iter `report.md`, lock report) → Tasks 4, 9
- §8 New code surface — all four items covered
- §9 Limitations — acknowledged in code comments where relevant; no mitigation tasks
- §10 Future extensions — not in scope, deferred per spec
- §11 Operational checklist — supported end-to-end by Tasks 1–20

**Placeholder scan:** No "TBD"/"TODO" remaining. Where I marked "fill in following X pattern" (Task 9 step 5, Task 11), that's a deliberate handoff because the existing pattern is the authoritative source.

**Type consistency:** `IterAccuracy`, `EligibilityResult`, `LockTestManifest`, `CohortSampling`, `PilotListing`, `PerCriterionAccuracy`, `IterSnapshot` all consistently defined and consistently named across tasks.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-02-guideline-refinement-loop-mvp.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
