# Session-Isolated Review State + Loud-Fail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each session its own per-patient review state (no cross-session overlap), and make an errored/no-write agent run fail loudly instead of promoting stale answers.

**Architecture:** Committed review state moves from `var/reviews/<pid>/<taskId>/` to `var/reviews/<sessionId>/<pid>/<taskId>/`. Two mechanisms scope it: (1) `pathFor.reviewState` gains a `sessionId` for direct-fs callers; (2) the domain-review handlers (which resolve paths through the overridable `reviewsRoot()`) are wrapped in `withReviewsRoot(var/reviews/<sessionId>)` — no domain-review internals change. The run loop captures the agent `error` event and counts real `set_field_assessment` writes; an agent that errors or writes nothing produces no draft.

**Tech Stack:** TypeScript (Express routes, Vitest), React 18, Node fs.

**Spec:** `docs/superpowers/specs/2026-06-06-session-isolated-review-state-design.md`

---

## Key facts (verified against the code)

- `packages/storage/src/index.ts` → `pathFor.reviewState(patientId, taskId)` builds `<PLATFORM_ROOT>/var/reviews/<pid>/<taskId>/review_state.json` from `PLATFORM_ROOT` directly.
- `packages/domain-review/src/review-state.ts` builds its path from `reviewsRoot()` (default `<PLATFORM_ROOT>/var/reviews`, overridable via `withReviewsRoot`/`CHART_REVIEW_REVIEWS_ROOT`). It exports `withReviewsRoot<T>(root, fn): Promise<T>` and `REVIEWS_ROOT`.
- `server/review-routes.ts` validate/unvalidate/actions go through domain-review (`applyUiAction`, `loadOrCreate`); 4 span-patch sites use `pathFor.reviewState` directly.
- `server/performance-routes.ts:58` and `server/export-routes.ts:76` build `path.join(PLATFORM_ROOT, "var", "reviews", pid, taskId, "review_state.json")` manually.
- `server/core-routes.ts:34` returns `storagePathFor.reviewState(patientId, taskId)`.
- `server/jobs-routes.ts` import (`POST /api/runs/:runId/patients/:patientId/import`) writes `reviewStatePath`.
- Iter manifests (`packages/domain-iter/src/pilots.ts`) carry `session_id` + `run_id`; `listPilotIterations(taskId)` returns them — the run→session lookup.
- `runs.ts` `runOneAgent` ignores the `error` event (`for await … if (event.type === "result")`) and promotes the scratch on `existsSync` (`runs.ts:776`).
- The naming trap: in review-routes, `sessionId: "reviewer__<id>"` is the **reviewer/MCP audit** session — NOT the workspace session. Do not conflate. The workspace session id arrives as `?session_id=`.

## File Structure

- `packages/storage/src/index.ts` — `pathFor.reviewState` gains `sessionId` (first arg).
- `server/lib/session-reviews.ts` — **new.** Two tiny helpers: `sessionReviewsRoot(sessionId)` and `sessionIdForRun(taskId, runId)`. One responsibility: resolve session-scoped review locations.
- `server/review-routes.ts` — wrap state-mutating/reading handlers in `withReviewsRoot(sessionReviewsRoot(sid))`; pass `sid` to the 4 `pathFor.reviewState` calls.
- `server/jobs-routes.ts` — import writes under the run's session; skip `*.error.json` markers.
- `server/performance-routes.ts` — read `var/reviews/<sessionId>/`; delete the `sessionRunIds` filter.
- `server/export-routes.ts` — read `var/reviews/<sessionId>/`.
- `server/core-routes.ts` — patient status per active session.
- `packages/infra-batch-run/src/runs.ts` — capture error + count writes + fail agent; per-patient rollup.
- `client/src/ui/Workspace/{PhaseValidate,PhaseDecide,index}.tsx` + review API calls — pass `session_id`; render failed patients/agents.

---

## Part B — Loud-fail on agent error (do first; self-contained, de-risks the run loop)

### Task B1: `runOneAgent` fails an errored / no-write agent

**Files:**
- Modify: `packages/infra-batch-run/src/runs.ts` (the `runAgent` loop ~760-780 and the promote block)
- Test: `packages/infra-batch-run/src/run-one-agent-failure.test.ts` (new)

- [ ] **Step 1: Read the current loop + promote block.** Read `packages/infra-batch-run/src/runs.ts` lines 740-820 to see `runOneAgent`'s signature, the `for await (const event of runAgent(...))` loop, the audit-hook wiring (`buildAuditHooks`), and the scratch-promote block (`if (!fs.existsSync(scratchReviewState)) throw …; fs.renameSync(…)`).

- [ ] **Step 2: Write the failing test.** This test drives the *decision* function extracted in Step 3, so it needs no subprocess.

```ts
// packages/infra-batch-run/src/run-one-agent-failure.test.ts
import { describe, it, expect } from "vitest";
import { classifyAgentOutcome } from "./runs.js";

describe("classifyAgentOutcome", () => {
  it("fails when the agent emitted an error event", () => {
    expect(classifyAgentOutcome({ agentError: "APIConnectionError", writeCount: 0 }))
      .toEqual({ status: "error", error: "APIConnectionError" });
  });
  it("fails when the agent made zero set_field_assessment writes", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 0 }))
      .toEqual({ status: "error", error: "agent made no set_field_assessment writes this run" });
  });
  it("succeeds when the agent wrote at least one assessment and no error", () => {
    expect(classifyAgentOutcome({ agentError: null, writeCount: 2 }))
      .toEqual({ status: "ok" });
  });
  it("an error takes precedence even if some writes happened", () => {
    expect(classifyAgentOutcome({ agentError: "boom", writeCount: 1 }))
      .toEqual({ status: "error", error: "boom" });
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails.**
Run: `npx vitest run packages/infra-batch-run/src/run-one-agent-failure.test.ts`
Expected: FAIL — `classifyAgentOutcome` is not exported.

- [ ] **Step 4: Add the exported decision function** near the top of `runs.ts` (after imports):

```ts
/** Decide whether an agent run succeeded. An agent that emitted an error event,
 *  or that made zero set_field_assessment writes THIS run, did not produce a
 *  draft — promoting the seeded/carried-forward scratch would be a stale-answer
 *  bug (see the session-isolated-review-state spec). */
export function classifyAgentOutcome(
  o: { agentError: string | null; writeCount: number },
): { status: "ok" } | { status: "error"; error: string } {
  if (o.agentError) return { status: "error", error: o.agentError };
  if (o.writeCount === 0) {
    return { status: "error", error: "agent made no set_field_assessment writes this run" };
  }
  return { status: "ok" };
}
```

- [ ] **Step 5: Wire capture + count into `runOneAgent`.** In the `for await` loop, capture the error; add a write counter via the audit hook. Replace the loop body so it reads:

```ts
    let agentError: string | null = null;
    let writeCount = 0;
    const auditHooks = buildAuditHooks({ patientId, taskId, sessionId });
    // wrap the PostToolUse hook to count set_field_assessment calls
    const countingPost = (...args: any[]) => {
      try {
        const toolName = (args[0]?.tool_name ?? args[0]?.toolName ?? "") as string;
        if (toolName === "set_field_assessment") writeCount += 1;
      } catch { /* counting is best-effort */ }
      return (auditHooks.post as any)(...args);
    };
```
Use `countingPost` where `auditHooks.post` was registered in `sdkHooks.PostToolUse`. Then in the event loop add the error capture:
```ts
      if (event.type === "error") agentError = event.error ?? "agent error";
      if (event.type === "result" && typeof event.cost_usd === "number") {
        cost = (cost ?? 0) + event.cost_usd;
      }
```
> If the audit hook payload's tool-name field differs, read `buildAuditHooks` to confirm the field name before finalizing; the counter must increment on each `set_field_assessment` PostToolUse.

- [ ] **Step 6: Gate the promote on the outcome.** Replace the promote block:
```ts
  const outcome = classifyAgentOutcome({ agentError, writeCount });
  if (outcome.status === "error") {
    // Do NOT promote: a seeded/carried scratch is not this run's output.
    const markerPath = path.join(ppDir, "agents", `${spec.id}.error.json`);
    try {
      fs.writeFileSync(markerPath, JSON.stringify(
        { agent_id: spec.id, status: "error", error: outcome.error }, null, 2));
    } catch { /* marker is best-effort */ }
    return { status: "error", error: outcome.error, cost_usd: cost };
  }
  // success: promote as before
  const scratchReviewState = path.join(scratchRoot, patientId, taskId, "review_state.json");
  if (!fs.existsSync(scratchReviewState)) {
    throw new Error(`agent ${spec.id} reported writes but no review_state.json — internal error`);
  }
  fs.renameSync(scratchReviewState, agentDraftPath(runId, patientId, spec.id));
```
Update `OnePatientOutput` / `runOneAgent`'s return type to include the `status: "ok" | "error"` and optional `error` (read the existing return type and extend it; keep `cost_usd`, `field_count`, `confidence_summary` optional).

- [ ] **Step 7: Run tests + typecheck.**
Run: `npx vitest run packages/infra-batch-run/src/run-one-agent-failure.test.ts` → PASS (4).
Run: `npm run typecheck` → no errors.

- [ ] **Step 8: Commit.**
```bash
cd <repo>
git add chart-review-platform-light/packages/infra-batch-run/src/runs.ts chart-review-platform-light/packages/infra-batch-run/src/run-one-agent-failure.test.ts
git commit -m "feat(light): fail an errored/no-write agent instead of promoting stale draft

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B2: Per-patient rollup → patient status reflects failures

**Files:**
- Modify: `packages/infra-batch-run/src/runs.ts` (the per-patient driver that calls `runOneAgent` per spec, ~610-635)
- Test: `packages/infra-batch-run/src/patient-rollup.test.ts` (new)

- [ ] **Step 1: Read the per-patient driver** (~600-635) that loops `specs` calling `runOneAgent` and aggregates `OnePatientOutput`. Note how it currently records per-patient status into the run status file.

- [ ] **Step 2: Write the failing test** for the rollup rule:
```ts
// packages/infra-batch-run/src/patient-rollup.test.ts
import { describe, it, expect } from "vitest";
import { rollupPatientStatus } from "./runs.js";

describe("rollupPatientStatus", () => {
  it("failed when every agent errored", () => {
    expect(rollupPatientStatus([{ status: "error" }, { status: "error" }])).toBe("failed");
  });
  it("complete_with_errors when some agents errored", () => {
    expect(rollupPatientStatus([{ status: "ok" }, { status: "error" }])).toBe("complete_with_errors");
  });
  it("complete when all agents succeeded", () => {
    expect(rollupPatientStatus([{ status: "ok" }, { status: "ok" }])).toBe("complete");
  });
});
```

- [ ] **Step 3: Run → FAIL** (`rollupPatientStatus` not exported).
Run: `npx vitest run packages/infra-batch-run/src/patient-rollup.test.ts`

- [ ] **Step 4: Add the function** to `runs.ts`:
```ts
/** Per-patient status from its agents' outcomes. */
export function rollupPatientStatus(
  outcomes: Array<{ status: "ok" | "error" }>,
): "complete" | "complete_with_errors" | "failed" {
  const ok = outcomes.filter((o) => o.status === "ok").length;
  if (ok === 0) return "failed";
  if (ok < outcomes.length) return "complete_with_errors";
  return "complete";
}
```

- [ ] **Step 5: Use it in the driver.** After collecting the per-spec `OnePatientOutput[]`, compute `rollupPatientStatus(outcomes)` and write it as the patient's status in the run status file (matching the existing status-write shape). When the status is `failed`, do NOT trigger any draft import for that patient.

- [ ] **Step 6: Run tests + typecheck.**
Run: `npx vitest run packages/infra-batch-run/src/patient-rollup.test.ts` → PASS (3); `npm run typecheck` → clean.

- [ ] **Step 7: Commit.**
```bash
git add chart-review-platform-light/packages/infra-batch-run/src/runs.ts chart-review-platform-light/packages/infra-batch-run/src/patient-rollup.test.ts
git commit -m "feat(light): roll up per-patient run status from agent outcomes"
```

### Task B3: UI surfaces failed agents/patients

**Files:**
- Modify: `client/src/ui/Workspace/PhaseTry.tsx` (`RunStatusCard`)
- Modify: `client/src/ui/Workspace/PhaseValidate.tsx`
- Test: extend `client/src/__tests__/PhaseTry.test.tsx` (or new `RunStatusCard.failed.test.tsx`)

- [ ] **Step 1: Read** `RunStatusCard` in `PhaseTry.tsx` and how it reads run/patient status (`run_status`, `n_complete`, `n_patients`). Read `PhaseValidate.tsx`'s patient-tile rendering.

- [ ] **Step 2: Write the failing test** — a `RunStatusCard` with a failed run shows "failed", not the ready-to-validate affordance:
```tsx
// client/src/__tests__/RunStatusCard.failed.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { render, screen } from "@testing-library/react";
import { RunStatusCard } from "../ui/Workspace/PhaseTry";
expect.extend(matchers);

describe("RunStatusCard failed run", () => {
  it("shows a failed state when run_status is failed", () => {
    render(<RunStatusCard iter={{ iter_id: "i1", iter_num: 1, state: "running",
      run_status: "failed", n_complete: 0, n_patients: 1, started_at: "", started_by: "x" } as any}
      patients={["p1"]} />);
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });
});
```
> If `RunStatusCard` isn't exported, export it (and confirm its real prop names by reading the component — adjust the test props to match).

- [ ] **Step 3: Run → FAIL.** `npx vitest run client/src/__tests__/RunStatusCard.failed.test.tsx`

- [ ] **Step 4: Implement.** In `RunStatusCard`: when `iter.run_status === "failed"`, render a failed banner ("Run failed — all agents errored. See the agent log.") and suppress the "Validate run" affordance. When `run_status === "complete_with_errors"`, show "N drafted · M failed". In `PhaseValidate.tsx`, render a `failed` patient tile as failed (muted, not clickable to validate).

- [ ] **Step 5: Run the new test + full suite.**
Run: `npx vitest run --reporter=dot` → all pass; `npm run typecheck` → clean.

- [ ] **Step 6: Commit.**
```bash
git add chart-review-platform-light/client/src/ui/Workspace/PhaseTry.tsx chart-review-platform-light/client/src/ui/Workspace/PhaseValidate.tsx chart-review-platform-light/client/src/__tests__/RunStatusCard.failed.test.tsx
git commit -m "feat(light): surface failed agents/patients in TRY + VALIDATE"
```

---

## Part A — Session-isolated review state

### Task A1: `pathFor.reviewState` gains `sessionId` + session-reviews helpers

**Files:**
- Modify: `packages/storage/src/index.ts`
- Create: `server/lib/session-reviews.ts`
- Test: `packages/storage/src/path-for.test.ts` (new); `server/lib/session-reviews.test.ts` (new)

- [ ] **Step 1: Write the failing storage test.**
```ts
// packages/storage/src/path-for.test.ts
import { describe, it, expect } from "vitest";
import { pathFor } from "./index.js";

describe("pathFor.reviewState", () => {
  it("scopes the path under the session id", () => {
    const p = pathFor.reviewState("session9", "patient_1", "lung-cancer-phenotype-light");
    expect(p.endsWith("/var/reviews/session9/patient_1/lung-cancer-phenotype-light/review_state.json")).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pathFor.reviewState` currently takes 2 args).
Run: `npx vitest run packages/storage/src/path-for.test.ts`

- [ ] **Step 3: Update `pathFor.reviewState`** in `packages/storage/src/index.ts`:
```ts
  /** `<root>/var/reviews/<sessionId>/<patient>/<task>/review_state.json` —
   *  per-session, per-patient ground-truth document. Session-scoped so two
   *  sessions never share a patient's answers. */
  reviewState(sessionId: string, patientId: string, taskId: string): string {
    return path.join(
      PLATFORM_ROOT, "var", "reviews", sessionId, patientId, taskId, "review_state.json",
    );
  },
```

- [ ] **Step 4: Write the session-reviews helper test.**
```ts
// server/lib/session-reviews.test.ts
import { describe, it, expect } from "vitest";
import { sessionReviewsRoot } from "./session-reviews.js";

describe("sessionReviewsRoot", () => {
  it("returns var/reviews/<sessionId>", () => {
    expect(sessionReviewsRoot("session9").endsWith("/var/reviews/session9")).toBe(true);
  });
});
```

- [ ] **Step 5: Run → FAIL** (module missing). `npx vitest run server/lib/session-reviews.test.ts`

- [ ] **Step 6: Create `server/lib/session-reviews.ts`.**
```ts
// session-reviews.ts — session-scoped review locations. One responsibility:
// turn a workspace session id (and optionally a run id) into the directory /
// review-state root for that session. See the session-isolated-review-state spec.
import path from "node:path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { listPilotIterations } from "./domain/iter/index.js";

/** The reviews root for one session: <root>/var/reviews/<sessionId>.
 *  Pass to withReviewsRoot() to scope domain-review reads/writes. */
export function sessionReviewsRoot(sessionId: string): string {
  return path.join(PLATFORM_ROOT, "var", "reviews", sessionId);
}

/** The session a run belongs to (iter manifests carry session_id + run_id).
 *  Returns null if no iter references the run. */
export function sessionIdForRun(taskId: string, runId: string): string | null {
  const iter = listPilotIterations(taskId).find((i) => i.run_id === runId);
  return iter?.session_id ?? null;
}
```

- [ ] **Step 7: Run both tests → PASS; typecheck (expect errors at the OLD 2-arg call sites — those are fixed in A2/A4/A5/A6).** Note: typecheck will surface every `pathFor.reviewState(pid, taskId)` caller as a 2-vs-3 arg error. That list IS the A2/A4/A5/A6 worklist. Record it.
Run: `npx vitest run packages/storage/src/path-for.test.ts server/lib/session-reviews.test.ts`
Run: `npm run typecheck` (expect arg-count errors in review-routes.ts, core-routes.ts — fixed next tasks)

- [ ] **Step 8: Commit.**
```bash
git add chart-review-platform-light/packages/storage/src/index.ts chart-review-platform-light/packages/storage/src/path-for.test.ts chart-review-platform-light/server/lib/session-reviews.ts chart-review-platform-light/server/lib/session-reviews.test.ts
git commit -m "feat(light): session-scoped reviewState path + session-reviews helpers"
```

### Task A2: review-routes — scope validate/unvalidate/actions/spans to the session

**Files:**
- Modify: `server/review-routes.ts`

- [ ] **Step 1: Read** the route handlers that read/write committed state: `/actions` (381), `/validate` (401), `/unvalidate` (435), `/summary` (236), `/evidence` (250, 265), span PATCH (472+, uses `pathFor.reviewState`), and the local `applyReviewerAction` (93). Confirm which call domain-review functions (`applyUiAction`/`loadOrCreate`/`applyReviewerAction`) vs direct `pathFor.reviewState`.

- [ ] **Step 2: Add the import + a small wrapper helper** at the top of `review-routes.ts`:
```ts
import { withReviewsRoot } from "@chart-review/domain-review";
import { sessionReviewsRoot } from "./lib/session-reviews.js";

/** Read the workspace session id from the request query. Required for all
 *  committed-state reads/writes so sessions stay isolated. */
function sessionIdOf(query: URLSearchParams): string {
  const sid = query.get("session_id");
  if (!sid) {
    const e = new Error("session_id query param is required") as Error & { status: number };
    e.status = 400;
    throw e;
  }
  return sid;
}
```
> The route handler signature is `(body, req, p, query)` — confirm by reading an existing handler; `query` is a `URLSearchParams`.

- [ ] **Step 3: Wrap each committed-state handler body** in `withReviewsRoot(sessionReviewsRoot(sid), async () => { … })`. For `/validate`:
```ts
    handler: async (_body, req, p, query) => {
      const sid = sessionIdOf(query);
      return withReviewsRoot(sessionReviewsRoot(sid), async () => {
        const reviewerId = readReviewerFromRequest(req) ?? "anonymous-reviewer";
        // … existing body unchanged …
        return { ok: true, gate_results, state: result.state };
      });
    },
```
Apply the same wrap to `/unvalidate`, `/actions`, `/summary`, `/evidence` (POST+DELETE), and the GET `/api/reviews/:patientId/:taskId` read handler (so the validate screen reads the session's state). For the span-PATCH sites that call `pathFor.reviewState(p.patientId, p.taskId)`, change to `pathFor.reviewState(sid, p.patientId, p.taskId)` (these still need the session id even inside the wrap, since they bypass `reviewsRoot()`).

- [ ] **Step 4: Typecheck.**
Run: `npm run typecheck` — the review-routes arg-count errors from A1 are now resolved. (core-routes still pending → A6.)

- [ ] **Step 5: Manual smoke** (server running): validating in session A then opening session B shows B empty.
```bash
curl -s -X POST "http://localhost:3002/api/reviews/PID/lung-cancer-phenotype-light/validate?session_id=SESSION_A" | head -c 200
```
(Use a real PID/session from `var/runs`. Expect `ok:true` or a `gate_results` block, written under `var/reviews/SESSION_A/`.)

- [ ] **Step 6: Commit.**
```bash
git add chart-review-platform-light/server/review-routes.ts
git commit -m "feat(light): scope review-state reads/writes to the workspace session"
```

### Task A3: import writes under the run's session + skips error markers

**Files:**
- Modify: `server/jobs-routes.ts`

- [ ] **Step 1: Read** the import handler (`POST /api/runs/:runId/patients/:patientId/import`, ~146-365): how `reviewStatePath` is built, how it discovers agent draft files (`agents/*.json`), and the `force`/merge logic.

- [ ] **Step 2: Resolve the session + write session-scoped.** At the top of the handler, resolve the run's session and build the path under it:
```ts
import { sessionIdForRun } from "./lib/session-reviews.js";
import { pathFor } from "@chart-review/storage";
// …
const sid = sessionIdForRun(taskId, p.runId);
if (!sid) {
  throw httpErr(409, `run ${p.runId} has no owning session; cannot import`);
}
const reviewStatePath = pathFor.reviewState(sid, p.patientId, taskId);
```
(Replace the existing `reviewStatePath` construction.)

- [ ] **Step 3: Skip error markers** when enumerating agent drafts. Where the handler lists `agents/*.json`, exclude files ending in `.error.json` (Part B writes those for failed agents). Add to the filter:
```ts
  .filter((f) => f.endsWith(".json") && !f.endsWith(".error.json") && !f.endsWith("_transcript.jsonl"))
```
(Match the existing filter location; the key addition is `!f.endsWith(".error.json")`.)

- [ ] **Step 4: Typecheck + smoke.**
Run: `npm run typecheck` → clean. With a real run, `POST /api/runs/<runId>/patients/<pid>/import` writes `var/reviews/<sid>/<pid>/<task>/review_state.json`.

- [ ] **Step 5: Commit.**
```bash
git add chart-review-platform-light/server/jobs-routes.ts
git commit -m "feat(light): import writes under the run's session; skip error markers"
```

### Task A4: performance reads the session dir; drop the run-id filter

**Files:**
- Modify: `server/performance-routes.ts`
- Test: existing perf behavior via a fixture dir (new `server/performance-routes.session.test.ts` optional)

- [ ] **Step 1: Read** `computePerformance` (50-139) and the route (141-171). Note it currently walks `var/reviews/<pid>/<taskId>` and filters by `sessionRunIds`.

- [ ] **Step 2: Re-scope to the session dir.** Change `computePerformance(taskId, primaryCriterionIds, sessionRunIds)` → `computePerformance(sessionId, taskId, primaryCriterionIds)`. Replace `reviewsDir = path.join(PLATFORM_ROOT, "var", "reviews")` and the `for (const pid of fs.readdirSync(reviewsDir))` walk with a walk of `path.join(PLATFORM_ROOT, "var", "reviews", sessionId)`. Read each `<sessionDir>/<pid>/<taskId>/review_state.json`. **Delete** the `sessionRunIds` parameter and the `if (sessionRunIds && !sessionRunIds.has(run)) continue;` line — isolation is now structural.

- [ ] **Step 3: Update the route** to require `session_id` and pass it:
```ts
      const sessionId = query.get("session_id");
      if (!sessionId) throw httpErr(400, "session_id is required");
      return computePerformance(sessionId, p.taskId, primaryCriterionIds);
```
(Read the top of the file for the `httpErr` helper or inline the 400 as other routes do.)

- [ ] **Step 4: Update export-routes' import** if it imports `computePerformance` with the old signature (it does — Task A5 handles its call).

- [ ] **Step 5: Typecheck.** `npm run typecheck` (export-routes call fixed in A5).

- [ ] **Step 6: Commit.**
```bash
git add chart-review-platform-light/server/performance-routes.ts
git commit -m "feat(light): performance reads the session's review dir (structural isolation)"
```

### Task A5: export reads the session dir

**Files:**
- Modify: `server/export-routes.ts`

- [ ] **Step 1: Read** export-routes (it builds `reviewsDir = var/reviews`, reads `<reviewsDir>/<pid>/<taskId>/review_state.json`, and calls `computePerformance(taskId, primaryCriterionIds, sessionRunIds)`).

- [ ] **Step 2: Re-scope.** It already has `sessionId` (from `?session_id=`). Change the gold-answer loop to read `path.join(PLATFORM_ROOT, "var", "reviews", sessionId, pid, p.taskId, "review_state.json")`. Update the `computePerformance` call to the new signature: `computePerformance(sessionId, p.taskId, primaryCriterionIds)`. Delete the `sessionRunIds` construction block.

- [ ] **Step 3: Typecheck + smoke.** `npm run typecheck` → clean. `POST /api/export/<task>?session_id=<sid>` writes a package reading only that session's gold answers.

- [ ] **Step 4: Commit.**
```bash
git add chart-review-platform-light/server/export-routes.ts
git commit -m "feat(light): export reads the session's gold answers"
```

### Task A6: patient-status per active session

**Files:**
- Modify: `server/core-routes.ts`

- [ ] **Step 1: Read** `core-routes.ts:34` (`reviewStatePath` helper) and the patient-list/status handler (118-150) that reads `rs.review_status` per patient.

- [ ] **Step 2: Make status session-scoped.** The patient-status handler should accept `?session_id=`. When present, read `pathFor.reviewState(sessionId, pid, taskId)`; when absent (patient list shown with no active session, e.g. the cohort picker), report no review_status (the patient simply has no per-session state yet). Update the `reviewStatePath` helper to take `sessionId`, and update its callers in this file. For the no-session case, skip the review_state read entirely and return the patient without `review_status`.

- [ ] **Step 3: Typecheck.** `npm run typecheck` → now fully clean (all `pathFor.reviewState` callers updated).

- [ ] **Step 4: Commit.**
```bash
git add chart-review-platform-light/server/core-routes.ts
git commit -m "feat(light): patient review-status scoped to the active session"
```

### Task A7: client passes `session_id` on review calls + reads failed status

**Files:**
- Modify: `client/src/ui/Workspace/PhaseValidate.tsx`, `client/src/ui/Workspace/PhaseDecide.tsx`, `client/src/ui/Workspace/index.tsx` (and any review fetch helper)

- [ ] **Step 1: Grep the client for the affected calls.**
Run: `grep -rn "/api/reviews/\|/api/performance/\|/api/export/\|/import\|review_status" client/src/ui/Workspace`
For each call to `…/validate`, `…/unvalidate`, `…/actions`, the review GET, `/api/performance/:taskId`, `/api/export/:taskId`, and the patient-status fetch, ensure `?session_id=${encodeURIComponent(activeSessionId)}` is appended. `activeSessionId` is already threaded into `PhaseValidate`/`PhaseDecide` (verify by reading their props).

- [ ] **Step 2: Add `session_id` to each call.** Example for the validate POST in `PhaseValidate.tsx`:
```ts
await authFetch(`/api/reviews/${encodeURIComponent(pid)}/${encodeURIComponent(taskId)}/validate?session_id=${encodeURIComponent(activeSessionId)}`, { method: "POST" });
```
(performance/export already pass `session_id` from earlier work — confirm and leave as-is.)

- [ ] **Step 3: Guard missing session.** If `activeSessionId` is null in `PhaseValidate`/`PhaseDecide`, render the existing "select/create a session" state rather than firing review calls (these phases already require an active session — confirm the guard exists; add if not).

- [ ] **Step 4: Typecheck + build + full tests.**
Run: `npm run typecheck` → clean; `npm run build:client` → ok; `npx vitest run --reporter=dot` → all pass.

- [ ] **Step 5: Commit.**
```bash
git add chart-review-platform-light/client/src/ui/Workspace/PhaseValidate.tsx chart-review-platform-light/client/src/ui/Workspace/PhaseDecide.tsx chart-review-platform-light/client/src/ui/Workspace/index.tsx
git commit -m "feat(light): client passes session_id on all review-state calls"
```

### Task A8: migration + full-stack verification

**Files:** none (one-time data wipe + verification)

- [ ] **Step 1: Wipe the pre-isolation state.**
```bash
cd <repo>/chart-review-platform-light
rm -rf var/reviews
```
(Gitignored dev/test data — the stale session9 validation and earlier runs.)

- [ ] **Step 2: All gates green.**
```bash
npm run typecheck && npm run build:client && npx vitest run --reporter=dot
cd python && ./.venv/bin/python -m pytest -q && cd ..
```
Expected: typecheck 0; client builds; all vitest pass; all pytest pass.

- [ ] **Step 3: End-to-end isolation check (server running, model = azure · gpt-4o).**
  1. Create session A, run on one patient, validate it → Performance shows it.
  2. Create session B with the same patient → VALIDATE shows the patient un-validated (blank), Performance for B shows nothing. Confirm `var/reviews/<A>/…` and `var/reviews/<B>/…` are separate dirs.

- [ ] **Step 4: End-to-end loud-fail check.** In a session, set both agents to the `vllm` model with no server running and Run. Expect: agent log shows the connection error; the run shows **failed** (not "ready to validate"); the patient is not validatable; `var/reviews/<session>/<pid>/…` has no validated stale data.

- [ ] **Step 5: Commit any verification fixes (if needed).**
```bash
git add -A && git commit -m "chore(light): verify session isolation + loud-fail end-to-end"
```

---

## Notes for the implementer

- **Run all commands from** `chart-review-platform-light/`; git from the repo root `<repo>`.
- **The "session" naming trap:** `reviewer__<id>` sessions in review-routes are audit/MCP sessions, NOT the workspace session. The workspace session id always arrives as `?session_id=`.
- **Two path mechanisms, one destination:** domain-review handlers are scoped via `withReviewsRoot(sessionReviewsRoot(sid))`; direct-fs callers (`pathFor.reviewState`, perf/export/jobs/core manual joins) build `var/reviews/<sessionId>/…`. Both resolve to the same per-session directory.
- **A1 deliberately breaks typecheck** at the old 2-arg call sites; that error list is the A2/A4/A5/A6 worklist. Typecheck is only expected fully green after A6 (server) and A7 (client).
- **Part B before Part A** is recommended (B is self-contained in runs.ts; A3's import then simply skips B's error markers). If executed A-first, A3 must still add the `.error.json` skip.
