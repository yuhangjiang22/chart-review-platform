# Iter Graduation Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the three workflow-level checks that the user's pilot loop needs but the platform doesn't have today: (1) verify-after-proposal-applied, (2) inter-iter regression gate that BLOCKS advance on any prior-validated patient regressing, (3) stop-rule that flags "ready to lock" after two consecutive iters with zero applied proposals.

**Architecture:** Three small additions in `app/server/domain/`, each behind an HTTP endpoint and unit-tested. They reuse existing primitives (`computeIterAccuracy`, the criterion-rerun machinery, `RuleProposal.applied`, the `pilots/iter_NNN/manifest.json` shape) rather than introducing new state. The `chart-review-improve` skill doc gets a paragraph pointing methodologists at the verify endpoint.

**Tech Stack:** TypeScript Node ESM, Vitest. No new dependencies.

---

## File Structure

**New files:**
- `app/server/domain/proposal/verify-application.ts` — verify-after-applied logic
- `app/server/domain/iter/regression-gate.ts` — inter-iter regression check
- `app/server/domain/iter/stop-rule.ts` — two-iter zero-applied-proposals rule
- `app/server/__tests__/verify-application.test.ts`
- `app/server/__tests__/regression-gate.test.ts`
- `app/server/__tests__/stop-rule.test.ts`

**Files modified:**
- `app/server/adapters/http/proposal-routes.ts` — add `POST /api/proposals/:taskId/:ruleId/verify`
- `app/server/adapters/http/pilot-routes.ts` — add `GET /api/pilots/:taskId/regression-check` and `GET /api/pilots/:taskId/stop-rule`
- `chart-review-platform/.claude/skills/chart-review-improve/SKILL.md` — note the verify step in the procedure

**Touchpoints (read-only references):**
- `app/server/domain/proposal/rule-store.ts` — `RuleProposal` shape with `applied.applied_at`, `trigger.patient_id`, `expected_outcome[].record_id`
- `app/server/domain/iter/iter-accuracy.ts` — `IterAccuracy` shape and `computeIterAccuracy`
- `app/server/domain/iter/pilots.ts` — pilot manifest reading
- `app/server/lock-test.ts` — patterns for "run agent on a known cohort"

---

## Task 1: Verify-after-proposal-applied (criterion-level)

**Files:**
- Create: `chart-review-platform/app/server/domain/proposal/verify-application.ts`
- Create: `chart-review-platform/app/server/__tests__/verify-application.test.ts`
- Modify: `chart-review-platform/app/server/adapters/http/proposal-routes.ts`

### Step 1 — Write the failing test

Create `chart-review-platform/app/server/__tests__/verify-application.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { verifyProposalApplication } from "../domain/proposal/verify-application.js";

let tmp: string;
const TID = "ph";

function seedSkill(taskId: string) {
  const skillDir = path.join(tmp, ".claude/skills", `chart-review-${taskId}`);
  fs.mkdirSync(path.join(skillDir, "references/criteria"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "meta.yaml"), "task_type: phenotype_validation\n");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: chart-review-ph\ndescription: t\n---\n");
  fs.writeFileSync(path.join(skillDir, "references/criteria/f1.md"),
`---
field_id: f1
answer_kind: boolean
---
`);
}

function seedAppliedProposal(taskId: string, ruleId: string, patientIds: string[]) {
  const dir = path.join(tmp, "proposals", taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ruleId}.yaml`),
`rule_id: ${ruleId}
task_id: ${taskId}
field_id: f1
status: applied
created_at: 2026-05-05T00:00:00Z
created_by: test
nl_rule: dummy
trigger:
  type: override
  patient_id: ${patientIds[0]}
expected_outcome:
${patientIds.map((p) => `  - record_id: ${p}\n    expected_change: flip-to-true`).join("\n")}
applied:
  applied_at: 2026-05-05T01:00:00Z
  applied_by: test
  resulting_sha: sha256:abc
`);
}

function seedReview(taskId: string, patientId: string, fieldId: string, truth: unknown) {
  const dir = path.join(tmp, "reviews", patientId, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"),
    JSON.stringify({
      patient_id: patientId,
      task_id: taskId,
      field_assessments: [
        { field_id: fieldId, answer: truth, source: "reviewer", status: "approved" },
      ],
    }),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  process.env.CHART_REVIEW_REVIEWS_ROOT = path.join(tmp, "reviews");
  seedSkill(TID);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

describe("verifyProposalApplication", () => {
  it("returns per-patient before/after for the targeted criterion only", async () => {
    seedAppliedProposal(TID, "r1", ["p1", "p2"]);
    seedReview(TID, "p1", "f1", true);
    seedReview(TID, "p2", "f1", false);

    const result = await verifyProposalApplication({
      taskId: TID,
      ruleId: "r1",
      reRunCriterion: async (_taskId, _patientId, _fieldId) => true,
    });

    expect(result.field_id).toBe("f1");
    expect(result.results).toEqual([
      { patient_id: "p1", agent_answer: true,  ground_truth: true,  matches: true  },
      { patient_id: "p2", agent_answer: true,  ground_truth: false, matches: false },
    ]);
    expect(result.fixed_count).toBe(1);
    expect(result.still_failing_count).toBe(1);
  });

  it("throws if the proposal is not in 'applied' status", async () => {
    const dir = path.join(tmp, "proposals", TID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "r2.yaml"),
`rule_id: r2
task_id: ${TID}
field_id: f1
status: draft
created_at: 2026-05-05T00:00:00Z
created_by: test
nl_rule: x
`);
    await expect(verifyProposalApplication({
      taskId: TID,
      ruleId: "r2",
      reRunCriterion: async () => null,
    })).rejects.toThrow(/not in applied status/i);
  });

  it("dedupes patient ids from trigger + expected_outcome", async () => {
    seedAppliedProposal(TID, "r3", ["p1", "p1", "p2"]);  // p1 in both trigger and expected_outcome
    seedReview(TID, "p1", "f1", true);
    seedReview(TID, "p2", "f1", true);
    const result = await verifyProposalApplication({
      taskId: TID,
      ruleId: "r3",
      reRunCriterion: async () => true,
    });
    expect(result.results.map((r) => r.patient_id).sort()).toEqual(["p1", "p2"]);
  });
});
```

### Step 2 — Run test, verify FAIL

```
cd "/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/app" && npx vitest run server/__tests__/verify-application.test.ts
```

Expected: FAIL — `verifyProposalApplication is not exported`.

### Step 3 — Implement

Create `chart-review-platform/app/server/domain/proposal/verify-application.ts`:

```typescript
/**
 * Verify-after-applied — re-run the targeted criterion on every patient
 * that motivated a proposal, and report which patients now match the
 * captured human ground truth.
 *
 * The actual agent re-run is injected as `reRunCriterion` so this module
 * stays pure (and so tests don't have to spin up the full batch-run
 * machinery). Production wires it to the existing criterion-rerun path.
 */
import * as fs from "fs";
import * as path from "path";
import { readProposal } from "./rule-store.js";
import { PLATFORM_ROOT } from "../../patients.js";

export interface VerifyResult {
  patient_id: string;
  agent_answer: unknown;
  ground_truth: unknown;
  matches: boolean;
}

export interface VerifyApplicationReport {
  rule_id: string;
  field_id: string;
  results: VerifyResult[];
  fixed_count: number;          // matches === true
  still_failing_count: number;  // matches === false
  computed_at: string;
}

export interface VerifyApplicationArgs {
  taskId: string;
  ruleId: string;
  reRunCriterion: (taskId: string, patientId: string, fieldId: string) => Promise<unknown>;
}

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "reviews");
}

function readGroundTruth(taskId: string, patientId: string, fieldId: string): unknown {
  const p = path.join(reviewsRoot(), patientId, taskId, "review_state.json");
  if (!fs.existsSync(p)) return undefined;
  const state = JSON.parse(fs.readFileSync(p, "utf8")) as {
    field_assessments?: Array<{ field_id: string; answer: unknown; source: string; status: string }>;
  };
  const fa = (state.field_assessments ?? []).find(
    (x) => x.field_id === fieldId && x.source === "reviewer" && x.status === "approved",
  );
  return fa?.answer;
}

export async function verifyProposalApplication(args: VerifyApplicationArgs): Promise<VerifyApplicationReport> {
  const proposal = readProposal(args.taskId, args.ruleId);
  if (!proposal) throw new Error(`proposal not found: ${args.taskId}/${args.ruleId}`);
  if (proposal.status !== "applied") {
    throw new Error(`proposal ${args.ruleId} is not in applied status (current: ${proposal.status})`);
  }

  const ids = new Set<string>();
  if (proposal.trigger?.patient_id) ids.add(proposal.trigger.patient_id);
  for (const exp of proposal.expected_outcome ?? []) {
    if (exp.record_id) ids.add(exp.record_id);
  }
  const patientIds = [...ids];

  const results: VerifyResult[] = [];
  for (const patientId of patientIds) {
    const agentAnswer = await args.reRunCriterion(args.taskId, patientId, proposal.field_id);
    const groundTruth = readGroundTruth(args.taskId, patientId, proposal.field_id);
    results.push({
      patient_id: patientId,
      agent_answer: agentAnswer,
      ground_truth: groundTruth,
      matches: agentAnswer === groundTruth,
    });
  }

  return {
    rule_id: args.ruleId,
    field_id: proposal.field_id,
    results,
    fixed_count: results.filter((r) => r.matches).length,
    still_failing_count: results.filter((r) => !r.matches).length,
    computed_at: new Date().toISOString(),
  };
}
```

### Step 4 — Run test, verify PASS

```
cd "/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/app" && npx vitest run server/__tests__/verify-application.test.ts
```

Expected: 3/3 pass.

### Step 5 — Wire HTTP endpoint

In `chart-review-platform/app/server/adapters/http/proposal-routes.ts`, add a new route. Read the existing file to find where other proposal routes are registered, and follow the same pattern:

```typescript
import { verifyProposalApplication } from "../../domain/proposal/verify-application.js";
import { rerunCriterionForPatient } from "../../infra/batch-run/index.js"; // or wherever the criterion-rerun fn lives — adapt to actual export

router.post("/proposals/:taskId/:ruleId/verify", async (req, res) => {
  try {
    const { taskId, ruleId } = req.params;
    const report = await verifyProposalApplication({
      taskId,
      ruleId,
      reRunCriterion: async (tid, pid, fid) => {
        const out = await rerunCriterionForPatient({ taskId: tid, patientId: pid, fieldId: fid });
        return out.answer;
      },
    });
    res.json(report);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
```

The exact `rerunCriterionForPatient` import name may differ. Read the criterion-rerun code (`app/server/__tests__/criterion-rerun.test.ts` shows the surface) and use whatever function actually re-runs a single criterion for a single patient. If no such function is yet exported in a clean form, either (a) export the smallest needed wrapper from the existing rerun code, or (b) defer wiring this endpoint and document it as a follow-up — the domain function is independently useful.

### Step 6 — Run full server suite

```
cd "/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/app" && npx vitest run server/__tests__/
```

Expected: 485+ pass (482 prior + 3 new), 1 skipped, 0 fail.

### Step 7 — Commit

```
cd "/Users/xinghe/Downloads/Chart Review Agents"
git add chart-review-platform/app/server/domain/proposal/verify-application.ts \
        chart-review-platform/app/server/__tests__/verify-application.test.ts \
        chart-review-platform/app/server/adapters/http/proposal-routes.ts
git commit -m "feat(proposal): verify a proposal closed the gap on its source patients"
```

No --no-verify.

---

## Task 2: Inter-iter regression gate (BLOCK)

**Files:**
- Create: `chart-review-platform/app/server/domain/iter/regression-gate.ts`
- Create: `chart-review-platform/app/server/__tests__/regression-gate.test.ts`
- Modify: `chart-review-platform/app/server/adapters/http/pilot-routes.ts`

The gate's contract: given a current iter state, enumerate every patient that any prior iter validated, re-run the agent on them with the current guideline, and return the set of patients whose CURRENT agent answer differs from their PREVIOUSLY-CAPTURED ground truth on any criterion. Non-empty result = BLOCK; empty = clear to advance.

### Step 1 — Write the failing test

Create `chart-review-platform/app/server/__tests__/regression-gate.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkRegression } from "../domain/iter/regression-gate.js";

let tmp: string;
const TID = "ph";

function seedSkill() {
  const skillDir = path.join(tmp, ".claude/skills", `chart-review-${TID}`);
  fs.mkdirSync(path.join(skillDir, "references/criteria"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "meta.yaml"), "task_type: phenotype_validation\n");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: chart-review-ph\ndescription: t\n---\n");
  for (const f of ["f1", "f2"]) {
    fs.writeFileSync(path.join(skillDir, "references/criteria", `${f}.md`),
      `---\nfield_id: ${f}\nanswer_kind: boolean\n---\n`);
  }
}

function seedIterManifest(iterId: string, patientIds: string[]) {
  const dir = path.join(tmp, ".claude/skills", `chart-review-${TID}`, "pilots", iterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    iter_id: iterId,
    task_id: TID,
    state: "complete",
    patient_ids: patientIds,
    started_at: "2026-05-01T00:00:00Z",
  }));
}

function seedReview(patientId: string, answers: Record<string, unknown>) {
  const dir = path.join(tmp, "reviews", patientId, TID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify({
    patient_id: patientId,
    task_id: TID,
    field_assessments: Object.entries(answers).map(([field_id, answer]) => ({
      field_id, answer, source: "reviewer", status: "approved",
    })),
  }));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rg-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  process.env.CHART_REVIEW_REVIEWS_ROOT = path.join(tmp, "reviews");
  seedSkill();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

describe("checkRegression", () => {
  it("returns no regressions when current agent matches all prior ground truth", async () => {
    seedIterManifest("iter_001", ["p1", "p2"]);
    seedReview("p1", { f1: true, f2: false });
    seedReview("p2", { f1: false, f2: true });

    const result = await checkRegression({
      taskId: TID,
      excludeIterIds: [],
      reRunPatient: async (_tid, pid) => {
        if (pid === "p1") return { f1: true, f2: false };
        if (pid === "p2") return { f1: false, f2: true };
        return {};
      },
    });

    expect(result.regressions).toEqual([]);
    expect(result.gate).toBe("clear");
    expect(result.patients_checked).toBe(2);
  });

  it("blocks when any prior patient now disagrees on any criterion", async () => {
    seedIterManifest("iter_001", ["p1"]);
    seedIterManifest("iter_002", ["p2"]);
    seedReview("p1", { f1: true, f2: false });
    seedReview("p2", { f1: false, f2: true });

    const result = await checkRegression({
      taskId: TID,
      excludeIterIds: [],
      reRunPatient: async (_tid, pid) => {
        if (pid === "p1") return { f1: true,  f2: true };  // f2 regressed
        if (pid === "p2") return { f1: false, f2: true };
        return {};
      },
    });

    expect(result.gate).toBe("blocked");
    expect(result.regressions).toEqual([
      { patient_id: "p1", field_id: "f2", was: false, now: true },
    ]);
  });

  it("excludes the iters in excludeIterIds (e.g., the current iter)", async () => {
    seedIterManifest("iter_001", ["p1"]);
    seedIterManifest("iter_002", ["p2"]);
    seedReview("p1", { f1: true });
    seedReview("p2", { f1: false });

    const result = await checkRegression({
      taskId: TID,
      excludeIterIds: ["iter_002"],
      reRunPatient: async (_tid, pid) => {
        return pid === "p1" ? { f1: true } : { f1: true /* would regress, but excluded */ };
      },
    });

    expect(result.gate).toBe("clear");
    expect(result.patients_checked).toBe(1);
  });
});
```

### Step 2 — Verify red

```
cd "/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/app" && npx vitest run server/__tests__/regression-gate.test.ts
```

### Step 3 — Implement

Create `chart-review-platform/app/server/domain/iter/regression-gate.ts`:

```typescript
/**
 * Inter-iter regression gate.
 *
 * Before advancing to a new pilot iter, every patient that prior iters
 * locked in as ground truth must still produce the same answers under
 * the CURRENT guideline state. Any disagreement blocks the advance —
 * the methodologist must either revert the offending proposal or
 * promote the failing patient into the new iter (and re-validate
 * its truth, which may legitimately change).
 */
import * as fs from "fs";
import * as path from "path";
import { guidelineDir } from "../rubric/index.js";
import { PLATFORM_ROOT } from "../../patients.js";

export interface Regression {
  patient_id: string;
  field_id: string;
  was: unknown;
  now: unknown;
}

export interface RegressionGateReport {
  task_id: string;
  patients_checked: number;
  regressions: Regression[];
  gate: "clear" | "blocked";
  computed_at: string;
}

export interface CheckRegressionArgs {
  taskId: string;
  /** Iter ids to skip — typically the iter that's about to start, since its
   *  patients haven't been validated yet. */
  excludeIterIds: string[];
  /** Production wires this to the batch-run / criterion-rerun infra; tests
   *  inject a fake. Returns answers keyed by field_id. */
  reRunPatient: (taskId: string, patientId: string) => Promise<Record<string, unknown>>;
}

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "reviews");
}

function listPriorPatients(taskId: string, excludeIterIds: string[]): string[] {
  const pilotsDir = path.join(guidelineDir(taskId), "pilots");
  if (!fs.existsSync(pilotsDir)) return [];
  const exclude = new Set(excludeIterIds);
  const patients = new Set<string>();
  for (const entry of fs.readdirSync(pilotsDir).sort()) {
    if (exclude.has(entry)) continue;
    const manifestPath = path.join(pilotsDir, entry, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { patient_ids?: string[] };
      for (const pid of m.patient_ids ?? []) patients.add(pid);
    } catch { /* skip malformed */ }
  }
  return [...patients];
}

function loadGroundTruth(taskId: string, patientId: string): Record<string, unknown> {
  const p = path.join(reviewsRoot(), patientId, taskId, "review_state.json");
  if (!fs.existsSync(p)) return {};
  const state = JSON.parse(fs.readFileSync(p, "utf8")) as {
    field_assessments?: Array<{ field_id: string; answer: unknown; source: string; status: string }>;
  };
  const out: Record<string, unknown> = {};
  for (const fa of state.field_assessments ?? []) {
    if (fa.source === "reviewer" && fa.status === "approved") out[fa.field_id] = fa.answer;
  }
  return out;
}

export async function checkRegression(args: CheckRegressionArgs): Promise<RegressionGateReport> {
  const patients = listPriorPatients(args.taskId, args.excludeIterIds);
  const regressions: Regression[] = [];

  for (const patient_id of patients) {
    const truth = loadGroundTruth(args.taskId, patient_id);
    const current = await args.reRunPatient(args.taskId, patient_id);
    for (const field_id of Object.keys(truth)) {
      if (current[field_id] !== truth[field_id]) {
        regressions.push({ patient_id, field_id, was: truth[field_id], now: current[field_id] });
      }
    }
  }

  return {
    task_id: args.taskId,
    patients_checked: patients.length,
    regressions,
    gate: regressions.length === 0 ? "clear" : "blocked",
    computed_at: new Date().toISOString(),
  };
}
```

### Step 4 — Verify green

```
cd "/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/app" && npx vitest run server/__tests__/regression-gate.test.ts
```

Expected: 3/3 pass.

### Step 5 — Wire HTTP endpoint

Add to `chart-review-platform/app/server/adapters/http/pilot-routes.ts`:

```typescript
import { checkRegression } from "../../domain/iter/regression-gate.js";

router.get("/pilots/:taskId/regression-check", async (req, res) => {
  try {
    const { taskId } = req.params;
    const exclude = (req.query.exclude as string | undefined)?.split(",").filter(Boolean) ?? [];
    const report = await checkRegression({
      taskId,
      excludeIterIds: exclude,
      reRunPatient: async (tid, pid) => {
        const out = await rerunPatientAllCriteria({ taskId: tid, patientId: pid });
        return out.answers;
      },
    });
    if (report.gate === "blocked") {
      res.status(409).json(report);  // 409 Conflict — caller should not advance
    } else {
      res.json(report);
    }
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
```

The `rerunPatientAllCriteria` function name is illustrative — find the actual existing function that re-runs all criteria on one patient with the current guideline. If no clean wrapper exists, write a thin one that calls the existing batch-run plumbing for a single patient. If wiring is non-trivial, ship the domain module + tests and document the endpoint as a follow-up — same logic as Task 1.

### Step 6 — Run full suite

```
cd "/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/app" && npx vitest run server/__tests__/
```

Expected: prior + 3, 0 fail.

### Step 7 — Commit

```
cd "/Users/xinghe/Downloads/Chart Review Agents"
git add chart-review-platform/app/server/domain/iter/regression-gate.ts \
        chart-review-platform/app/server/__tests__/regression-gate.test.ts \
        chart-review-platform/app/server/adapters/http/pilot-routes.ts
git commit -m "feat(iter): block iter advance when prior-validated patients regress"
```

---

## Task 3: Stop-rule (two consecutive zero-applied-proposal iters)

**Files:**
- Create: `chart-review-platform/app/server/domain/iter/stop-rule.ts`
- Create: `chart-review-platform/app/server/__tests__/stop-rule.test.ts`
- Modify: `chart-review-platform/app/server/adapters/http/pilot-routes.ts`

### Step 1 — Write the failing test

Create `chart-review-platform/app/server/__tests__/stop-rule.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { evaluateStopRule } from "../domain/iter/stop-rule.js";

let tmp: string;
const TID = "ph";

function seedSkill() {
  const skillDir = path.join(tmp, ".claude/skills", `chart-review-${TID}`);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "meta.yaml"), "task_type: phenotype_validation\n");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: chart-review-ph\ndescription: t\n---\n");
}

function seedIterManifest(iterId: string, opts: { state?: string; started_at: string; completed_at?: string }) {
  const dir = path.join(tmp, ".claude/skills", `chart-review-${TID}`, "pilots", iterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    iter_id: iterId,
    task_id: TID,
    state: opts.state ?? "complete",
    started_at: opts.started_at,
    completed_at: opts.completed_at,
  }));
}

function seedAppliedProposal(ruleId: string, applied_at: string) {
  const dir = path.join(tmp, "proposals", TID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ruleId}.yaml`),
`rule_id: ${ruleId}
task_id: ${TID}
field_id: f1
status: applied
created_at: ${applied_at}
created_by: test
nl_rule: x
applied:
  applied_at: ${applied_at}
  applied_by: test
  resulting_sha: sha:abc
`);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stop-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  seedSkill();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
});

describe("evaluateStopRule", () => {
  it("returns ready_to_lock when last 2 iters had zero applied proposals", () => {
    seedIterManifest("iter_001", { started_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-02T00:00:00Z" });
    seedIterManifest("iter_002", { started_at: "2026-05-02T00:00:00Z", completed_at: "2026-05-03T00:00:00Z" });
    seedIterManifest("iter_003", { started_at: "2026-05-03T00:00:00Z", completed_at: "2026-05-04T00:00:00Z" });
    seedAppliedProposal("r1", "2026-05-01T12:00:00Z");  // applied during iter_001
    // iter_002, iter_003 — no applied proposals

    const result = evaluateStopRule({ taskId: TID });
    expect(result.ready_to_lock).toBe(true);
    expect(result.reason).toMatch(/two consecutive iters/i);
    expect(result.applied_per_iter).toEqual([
      { iter_id: "iter_002", applied_count: 0 },
      { iter_id: "iter_003", applied_count: 0 },
    ]);
  });

  it("returns not-ready when the most recent iter had >0 applied proposals", () => {
    seedIterManifest("iter_001", { started_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-02T00:00:00Z" });
    seedIterManifest("iter_002", { started_at: "2026-05-02T00:00:00Z", completed_at: "2026-05-03T00:00:00Z" });
    seedAppliedProposal("r1", "2026-05-02T12:00:00Z");  // applied during iter_002
    const result = evaluateStopRule({ taskId: TID });
    expect(result.ready_to_lock).toBe(false);
  });

  it("returns not-ready with fewer than 2 complete iters", () => {
    seedIterManifest("iter_001", { started_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-02T00:00:00Z" });
    const result = evaluateStopRule({ taskId: TID });
    expect(result.ready_to_lock).toBe(false);
    expect(result.reason).toMatch(/at least two complete iters/i);
  });

  it("ignores incomplete iters", () => {
    seedIterManifest("iter_001", { started_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-02T00:00:00Z" });
    seedIterManifest("iter_002", { started_at: "2026-05-02T00:00:00Z", completed_at: "2026-05-03T00:00:00Z" });
    seedIterManifest("iter_003", { state: "running", started_at: "2026-05-03T00:00:00Z" });
    const result = evaluateStopRule({ taskId: TID });
    // Only iter_001 + iter_002 are complete; both had zero applied → ready
    expect(result.ready_to_lock).toBe(true);
  });
});
```

### Step 2 — Verify red

```
cd "/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/app" && npx vitest run server/__tests__/stop-rule.test.ts
```

### Step 3 — Implement

Create `chart-review-platform/app/server/domain/iter/stop-rule.ts`:

```typescript
/**
 * Stop-rule: the pilot loop is "ready to lock" when the last two complete
 * iters each landed with ZERO applied proposals.
 *
 * "Applied" means status === "applied" in the proposal store; rejected,
 * draft, or pending proposals don't count — the methodologist still found
 * something but didn't act on it, which is signal that the loop isn't
 * settled.
 */
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { guidelineDir } from "../rubric/index.js";
import { PLATFORM_ROOT } from "../../patients.js";

export interface StopRuleReport {
  task_id: string;
  ready_to_lock: boolean;
  reason: string;
  applied_per_iter: Array<{ iter_id: string; applied_count: number }>;
  computed_at: string;
}

interface IterWindow { iter_id: string; started_at: string; completed_at: string }

function proposalsDir(taskId: string): string {
  const root = process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT;
  return path.join(root, "proposals", taskId);
}

function listCompleteIters(taskId: string): IterWindow[] {
  const pilotsDir = path.join(guidelineDir(taskId), "pilots");
  if (!fs.existsSync(pilotsDir)) return [];
  const out: IterWindow[] = [];
  for (const entry of fs.readdirSync(pilotsDir).sort()) {
    const manifestPath = path.join(pilotsDir, entry, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        iter_id?: string; state?: string; started_at?: string; completed_at?: string;
      };
      if (m.state === "complete" && m.started_at && m.completed_at) {
        out.push({ iter_id: m.iter_id ?? entry, started_at: m.started_at, completed_at: m.completed_at });
      }
    } catch { /* skip */ }
  }
  return out;
}

function countAppliedInWindow(taskId: string, start: string, end: string): number {
  const dir = proposalsDir(taskId);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
    try {
      const proposal = parseYaml(fs.readFileSync(path.join(dir, f), "utf8")) as {
        status?: string; applied?: { applied_at?: string };
      };
      const ts = proposal.applied?.applied_at;
      if (proposal.status === "applied" && ts && ts >= start && ts <= end) n += 1;
    } catch { /* skip */ }
  }
  return n;
}

export function evaluateStopRule(args: { taskId: string }): StopRuleReport {
  const iters = listCompleteIters(args.taskId);
  if (iters.length < 2) {
    return {
      task_id: args.taskId,
      ready_to_lock: false,
      reason: `Need at least two complete iters (have ${iters.length}).`,
      applied_per_iter: iters.map((i) => ({
        iter_id: i.iter_id,
        applied_count: countAppliedInWindow(args.taskId, i.started_at, i.completed_at),
      })),
      computed_at: new Date().toISOString(),
    };
  }
  const lastTwo = iters.slice(-2);
  const counts = lastTwo.map((i) => ({
    iter_id: i.iter_id,
    applied_count: countAppliedInWindow(args.taskId, i.started_at, i.completed_at),
  }));
  const ready = counts.every((c) => c.applied_count === 0);
  return {
    task_id: args.taskId,
    ready_to_lock: ready,
    reason: ready
      ? "Last two consecutive iters each had zero applied proposals — guideline appears settled."
      : `Most recent iter had ${counts[counts.length - 1].applied_count} applied proposal(s); not yet two consecutive clean iters.`,
    applied_per_iter: counts,
    computed_at: new Date().toISOString(),
  };
}
```

### Step 4 — Verify green

```
cd "/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/app" && npx vitest run server/__tests__/stop-rule.test.ts
```

Expected: 4/4 pass.

### Step 5 — Wire HTTP endpoint

Add to `chart-review-platform/app/server/adapters/http/pilot-routes.ts`:

```typescript
import { evaluateStopRule } from "../../domain/iter/stop-rule.js";

router.get("/pilots/:taskId/stop-rule", (req, res) => {
  try {
    const report = evaluateStopRule({ taskId: req.params.taskId });
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
```

### Step 6 — Run full suite

```
cd "/Users/xinghe/Downloads/Chart Review Agents/chart-review-platform/app" && npx vitest run server/__tests__/
```

Expected: prior + 4, 0 fail.

### Step 7 — Commit

```
cd "/Users/xinghe/Downloads/Chart Review Agents"
git add chart-review-platform/app/server/domain/iter/stop-rule.ts \
        chart-review-platform/app/server/__tests__/stop-rule.test.ts \
        chart-review-platform/app/server/adapters/http/pilot-routes.ts
git commit -m "feat(iter): stop-rule flags ready-to-lock after two clean iters"
```

---

## Task 4: Document the new gates in `chart-review-improve`

**Files:**
- Modify: `chart-review-platform/.claude/skills/chart-review-improve/SKILL.md`

### Step 1 — Add a new section after the existing "Procedure"

Read the existing SKILL.md, then append a new section titled `## Verifying applied proposals` under the existing procedure, with this content:

```markdown
## Verifying applied proposals

Once the methodologist accepts a proposal and the platform writes the
`applied` block on the proposal record, the platform exposes a verify
endpoint:

```
POST /api/proposals/:taskId/:ruleId/verify
```

It re-runs the targeted criterion on every patient that motivated the
proposal (the union of `trigger.patient_id` and `expected_outcome[].record_id`)
and returns per-patient `{ agent_answer, ground_truth, matches }`. If any
of those patients still don't match the captured ground truth, the
proposal didn't fully close its gap — recommend a follow-up proposal or
a guidance refinement before moving on.

## Iter graduation gates

Two further endpoints inform when a pilot can stop iterating and proceed
to lock-test:

- `GET /api/pilots/:taskId/regression-check?exclude=<iter_id>` — re-runs
  the agent on every patient validated in prior iters and returns any
  criterion-level disagreement against captured ground truth. Non-empty
  result returns HTTP 409 (gate blocked); the methodologist must either
  revert the offending change or promote the failing patient into a
  fresh iter sample for re-validation.

- `GET /api/pilots/:taskId/stop-rule` — reports whether the last two
  complete iters each landed with zero applied proposals. When yes, the
  guideline is considered settled and the methodologist should run
  `chart-review-calibrate` (held-out lock-test) before locking.
```

### Step 2 — Commit

```
cd "/Users/xinghe/Downloads/Chart Review Agents"
git add chart-review-platform/.claude/skills/chart-review-improve/SKILL.md
git commit -m "docs(improve): document verify + regression + stop-rule endpoints"
```

---

## Self-Review

**Spec coverage:**
- Verify-after-applied (criterion-level): Task 1 ✅
- Inter-iter regression gate (block style): Task 2 ✅
- Stop-rule (two consecutive zero-applied iters): Task 3 ✅
- Documented for the user/methodologist: Task 4 ✅

**Type consistency:**
- All three modules return shaped reports with `computed_at` ISO timestamps.
- All three accept dependency-injected re-run callables in their domain functions; the HTTP layer wires production callables.

**Risks:**
- Endpoint wiring assumes a clean single-patient-rerun export exists. If it doesn't, ship Task 1/2 domain functions + tests and document the endpoint as a follow-up — the gates work via the domain functions even without the HTTP adapter.
- The stop-rule's "applied during this iter" window is `[iter.started_at, iter.completed_at]`. If a methodologist applies a proposal *between* iters (after completed_at of N, before started_at of N+1), it won't be attributed to any iter and the rule will mistakenly read "clean." Document this and consider widening the window to `[iter_N.started_at, iter_N+1.started_at)` in v2 if it bites.
