# Session-Isolated Review State + Loud-Fail (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make v2's review state session-scoped (every consumer, incl. the publication pipeline, reads the active session) and make an errored/no-write agent fail loudly — generalized across phenotype/NER/adherence and claude/codex.

**Architecture:** Identical seam to chart-review-platform-light (a sibling package in this monorepo): `pathFor.reviewState` gains a `sessionId`; domain-review handlers are scoped by `withReviewsRoot(sessionReviewsRoot(sid))`; the run loop counts the task-kind's primary write from the AgentEvent stream and refuses to promote a draft when an agent errors or makes no write. Where the pattern is byte-identical to light, **read the light file as the reference** (paths given) and adapt the v2 file names.

**Tech Stack:** TypeScript, Vitest. Reuses v2's `infra-batch-run`, `domain-review` (`withReviewsRoot`), `storage`.

**Spec:** `docs/superpowers/specs/2026-06-08-session-isolated-review-state-design.md`
**Reference implementation (light, same monorepo):** `../chart-review-platform-light/` — the analogous files are cited per task.

---

## Reference map (light → v2)

| Concept | Light file (read as reference) | v2 file (apply to) |
|---|---|---|
| reviewState seam | `packages/storage/src/index.ts` (`reviewState(sessionId,pid,taskId)`) | same path in v2 |
| session-reviews helper | `server/lib/session-reviews.ts` | create in v2 |
| review-routes wrap | `server/review-routes.ts` (`sessionIdOf` + `withReviewsRoot`) | v2 `server/review-routes.ts` |
| import scoping | `server/jobs-routes.ts` | v2 `server/jobs-routes.ts` |
| performance | `server/performance-routes.ts` | v2 perf/accuracy routes |
| loud-fail | `packages/infra-batch-run/src/runs.ts` (`classifyAgentOutcome`, `applyAgentEventToTally`, `rollupPatientStatus`) | v2 `runs.ts` (generalized per kind) |
| run-card readiness | `client/src/ui/Workspace/PhaseTry.tsx` | v2 equivalent |

## Key facts (verified in v2)

- `pathFor.reviewState(patientId, taskId)` — `packages/storage/src/index.ts:35`. Direct callers: `core-routes.ts:34`, `review-routes.ts:454/500/602/652`, `ner-calibration-routes.ts:77/90`, `adherence-stats-routes.ts:68`, `adherence-iaa-routes.ts:75`, `adherence-summary-routes.ts:88`, `span-stats-routes.ts:70`, `packages/mcp-core-ner/src/index.ts:335`.
- Run loop: `runOneAgent(manifest, patientId, spec)` (`runs.ts:642`) has `task = loadCompiledTask(taskId)` and dispatches on `task.task_kind` (`"ner"` / `"adherence"` / else phenotype, lines 674-680). Scratch promote at `runs.ts:1032-1036`. `OnePatientOutput` at 607.
- Per-kind primary write tool: phenotype `set_field_assessment`, adherence `set_question_answer`, NER `set_span_label`. A completion signal = a `result` AgentEvent (always emitted on non-error completion) or `set_review_status`.
- `withReviewsRoot` is exported from v2's `@chart-review/domain-review` (same as light). v2 iter manifests carry `session_id` (sessions.ts present).

---

## Phase 1 — Working loop (session-scope the core)

### Task 1.1: `pathFor.reviewState` gains `sessionId` + `session-reviews.ts`

**Files:** Modify `packages/storage/src/index.ts`; Create `server/lib/session-reviews.ts`; Tests `packages/storage/src/path-for.test.ts`, `server/lib/session-reviews.test.ts`.

- [ ] **Step 1: Read the light reference** `../chart-review-platform-light/packages/storage/src/index.ts` (the `reviewState(sessionId, patientId, taskId)` form) and `../chart-review-platform-light/server/lib/session-reviews.ts` (`sessionReviewsRoot`, `sessionIdForRun`) + its test. The v2 versions are identical except v2's `listPilotIterations` import path.

- [ ] **Step 2: Write the failing storage test** `packages/storage/src/path-for.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { pathFor } from "./index.js";
describe("pathFor.reviewState", () => {
  it("scopes the path under the session id", () => {
    const p = pathFor.reviewState("sessionA", "patient_1", "lung-cancer");
    expect(p.endsWith("/var/reviews/sessionA/patient_1/lung-cancer/review_state.json")).toBe(true);
  });
});
```
Run `npx vitest run packages/storage/src/path-for.test.ts` → FAIL (2-arg).

- [ ] **Step 3: Update `reviewState`** in `packages/storage/src/index.ts`:
```ts
  reviewState(sessionId: string, patientId: string, taskId: string): string {
    return path.join(PLATFORM_ROOT, "var", "reviews", sessionId, patientId, taskId, "review_state.json");
  },
```

- [ ] **Step 4: Create `server/lib/session-reviews.ts`** (mirror light; confirm v2's iter-listing import):
```ts
import path from "node:path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { listPilotIterations } from "./domain/iter/index.js"; // confirm v2's path to the iter listing
export function sessionReviewsRoot(sessionId: string): string {
  return path.join(PLATFORM_ROOT, "var", "reviews", sessionId);
}
export function sessionIdForRun(taskId: string, runId: string): string | null {
  const iter = listPilotIterations(taskId).find((i) => i.run_id === runId);
  return iter?.session_id ?? null;
}
```
Write `server/lib/session-reviews.test.ts` mirroring light's (sessionReviewsRoot path; sessionIdForRun match/not-found/legacy-null via a mocked `listPilotIterations`).

- [ ] **Step 5: Run new tests → PASS; typecheck** (`npm run typecheck`) — EXPECT arg-count errors ONLY at the direct `reviewState(pid,taskId)` callers listed in Key facts. Record that list; it's the Phase-1/2 worklist. Do NOT fix them here.

- [ ] **Step 6: Commit** `feat(v2): session-scoped reviewState path + session-reviews helpers`.

### Task 1.2: scope `review-routes` to the session (incl. NER spans + adherence)

**Files:** Modify `server/review-routes.ts`.

- [ ] **Step 1: Read** light's `server/review-routes.ts` for the exact pattern: a `sessionIdOf(query)` helper (400 if absent) + wrapping every committed-state handler body in `withReviewsRoot(sessionReviewsRoot(sid), async () => {…})` (returned), and passing `sid` to direct `pathFor.reviewState` calls.

- [ ] **Step 2: Add imports + `sessionIdOf`** to v2 `review-routes.ts`:
```ts
import { withReviewsRoot } from "@chart-review/domain-review";
import { sessionReviewsRoot } from "./lib/session-reviews.js";
function sessionIdOf(query: URLSearchParams): string {
  const sid = query.get("session_id");
  if (!sid) throw httpErr(400, "session_id query param is required");
  return sid;
}
```

- [ ] **Step 3: Wrap every committed-state handler** in `withReviewsRoot(sessionReviewsRoot(sessionIdOf(query)), async () => {…})` and change the 4 direct `pathFor.reviewState(p.patientId, p.taskId)` calls (lines 454/500/602/652) to `pathFor.reviewState(sid, p.patientId, p.taskId)`. This INCLUDES v2's NER span handlers (`set_span_label`/status, span PATCH/DELETE) and adherence handlers (`set_question_answer`, rule verdicts) — they go through the same domain-review/`reviewsRoot()` path, so the wrap scopes them with no per-kind special-casing. Leave pure LLM-copilot/SSE handlers (suggest-override-reason, prelock-summary, find-quote-offsets) unwrapped (they touch no committed state). Confirm by reading each handler.

- [ ] **Step 4: Typecheck** — review-routes arg errors gone; remaining = core-routes + the Phase-2 consumers. **Run the existing suite** (`npx vitest run`); update any review-routes test to pass `?session_id=test`.

- [ ] **Step 5: Commit** `feat(v2): scope review-state reads/writes (incl. NER/adherence) to the session`.

### Task 1.3: import writes under the run's session

**Files:** Modify `server/jobs-routes.ts` (mirror light Task A3).
- Resolve `const sid = sessionIdForRun(taskId, runId)`; 409 if null; write `pathFor.reviewState(sid, pid, taskId)`; in the agent-draft enumeration add `&& !f.endsWith(".error.json")`. Remove any now-dead local `reviewsRoot()`.
- Steps: read light's jobs-routes diff; apply; typecheck; `npx vitest run`; commit `feat(v2): import writes under the run's session; skip error markers`.

### Task 1.4: performance / accuracy + core-routes patient status

**Files:** Modify the v2 performance/accuracy route(s) + `server/core-routes.ts`.
- Performance/accuracy reads: walk `var/reviews/<sessionId>/` (require `session_id`), mirroring light's `performance-routes.ts` (drop any run-id filter). core-routes: `reviewStatePath(sessionId, pid, taskId)`; require `session_id` for the status read, else return patients without `review_status` (no flat read) — mirror light Task A6.
- Steps per file: read light reference; apply; typecheck (should reach ZERO after core-routes); `npx vitest run`; commit `feat(v2): performance + patient-status scoped to the active session`.

---

## Phase 2 — Publication pipeline (read the active session)

Each consumer below currently calls `pathFor.reviewState(pid, taskId)` directly (the Key-facts list) or walks `var/reviews/`. **The transform is identical for all:** add a `session_id` input (route query param or function arg), and change reads to `pathFor.reviewState(sid, pid, taskId)` / walk `var/reviews/<sid>/`. For domain-review-based reads, wrap in `withReviewsRoot(sessionReviewsRoot(sid))`. LOCK additionally records the source `session_id`.

> This is wide but mechanical. One task per file keeps each reviewable. For each: (1) read the file's review_state reads, (2) thread `session_id`, (3) typecheck + run that file's tests (or the suite), (4) commit. The exact `pathFor.reviewState(sid, …)` substitution + the `?session_id=` requirement are the operative change in every one.

### Task 2.1: `lock-test-routes.ts`
Thread `session_id`; reads `var/reviews/<sid>/`; **persist the source `session_id` in the lock record** (add a `locked_from_session` field where the lock is written). Read the file, apply, typecheck, `npx vitest run`, commit `feat(v2): LOCK reads + records the active session`.

### Task 2.2: `ner-calibration-routes.ts` (lines 77, 90)
`pathFor.reviewState(sid, pid, p.taskId)` ×2; require `session_id`. Commit `feat(v2): NER calibration reads the active session`.

### Task 2.3: adherence reads — `adherence-stats-routes.ts:68`, `adherence-iaa-routes.ts:75`, `adherence-summary-routes.ts:88`
`pathFor.reviewState(sid, pid, taskId)`; require `session_id`. One commit `feat(v2): adherence stats/iaa/summary read the active session`.

### Task 2.4: `span-stats-routes.ts:70`
`pathFor.reviewState(sid, patientId, p.taskId)`; require `session_id`. Commit `feat(v2): span stats read the active session`.

### Task 2.5: `methods-routes.ts` + `lib/methods-drafter.ts`
Thread `session_id` to wherever the drafter reads validated review_states; read `var/reviews/<sid>/`. Commit `feat(v2): methods draft reads the active session`.

### Task 2.6: `proposal-routes.ts`, `feedback-routes.ts`, `lib/qa-panel.ts`, `lib/methodologist-pdf.ts`
For each, find its review_state read and thread `session_id` (route param or caller arg). These are auto-critique / QA / PDF surfaces. One task; per-file commits or a single `feat(v2): proposal/feedback/qa/pdf read the active session`.

### Task 2.7: `packages/mcp-core-ner/src/index.ts:335`
This computes a review-state path inside the NER MCP core. It runs inside the agent's scratch context (via `reviewsRoot()` override) during a run, so it is already scoped by the run loop's `withReviewsRoot(scratchRoot)`. **Verify** it uses `reviewsRoot()` (not a hardcoded `PLATFORM_ROOT`/flat path); if it uses `pathFor.reviewState(pid, taskId)` directly, that's the scratch-vs-committed boundary — confirm whether this read is meant to hit the scratch (leave) or the committed session state (then it needs the session). Document the finding; change only if it reads committed state. Commit if changed.

- [ ] After Phase 2: `npm run typecheck` → ZERO errors. `npx vitest run` → all pass.

---

## Phase 3 — Loud-fail, generalized per task kind

### Task 3.1: per-kind tally + classify (pure fns)

**Files:** Modify `packages/infra-batch-run/src/runs.ts`; Test `packages/infra-batch-run/src/agent-outcome.test.ts`.

- [ ] **Step 1: Read** light's `runs.ts` `applyAgentEventToTally` + `classifyAgentOutcome` and `agent-event-tally.test.ts` as the reference.

- [ ] **Step 2: Write the failing test** `agent-outcome.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { primaryWriteTool, classifyAgentOutcome } from "./runs.js";

describe("primaryWriteTool", () => {
  it("maps task kind → its write tool", () => {
    expect(primaryWriteTool("phenotype")).toBe("set_field_assessment");
    expect(primaryWriteTool("adherence")).toBe("set_question_answer");
    expect(primaryWriteTool("ner")).toBe("set_span_label");
  });
});

describe("classifyAgentOutcome", () => {
  it("error always fails", () => {
    expect(classifyAgentOutcome({ kind: "phenotype", agentError: "boom", writeCount: 5, completed: true }))
      .toEqual({ status: "error", error: "boom" });
  });
  it("phenotype/adherence: zero writes fails", () => {
    expect(classifyAgentOutcome({ kind: "phenotype", agentError: null, writeCount: 0, completed: true }).status).toBe("error");
    expect(classifyAgentOutcome({ kind: "adherence", agentError: null, writeCount: 0, completed: true }).status).toBe("error");
  });
  it("phenotype: >=1 write + completed → ok", () => {
    expect(classifyAgentOutcome({ kind: "phenotype", agentError: null, writeCount: 2, completed: true }))
      .toEqual({ status: "ok" });
  });
  it("NER: zero spans but completed → ok (valid empty result)", () => {
    expect(classifyAgentOutcome({ kind: "ner", agentError: null, writeCount: 0, completed: true }))
      .toEqual({ status: "ok" });
  });
  it("NER: no completion signal → fail", () => {
    expect(classifyAgentOutcome({ kind: "ner", agentError: null, writeCount: 0, completed: false }).status).toBe("error");
  });
});
```

- [ ] **Step 3: Run → FAIL.** `npx vitest run packages/infra-batch-run/src/agent-outcome.test.ts`

- [ ] **Step 4: Implement** in `runs.ts`:
```ts
import { type AgentEvent } from "@chart-review/agent-provider"; // add to existing import if needed

export type TaskKind = "phenotype" | "ner" | "adherence";
export function primaryWriteTool(kind: TaskKind): string {
  if (kind === "adherence") return "set_question_answer";
  if (kind === "ner") return "set_span_label";
  return "set_field_assessment";
}

export interface AgentTally { agentError: string | null; writeCount: number; completed: boolean; }
export function applyAgentEventToTally(t: AgentTally, ev: AgentEvent, writeTool: string): AgentTally {
  if (ev.type === "error") return { ...t, agentError: ev.error ?? "agent error" };
  if (ev.type === "result") return { ...t, completed: true };
  if (ev.type === "tool_use") {
    if (ev.tool_name === writeTool) return { ...t, writeCount: t.writeCount + 1 };
    if (ev.tool_name === "set_review_status") return { ...t, completed: true };
  }
  return t;
}

export function classifyAgentOutcome(
  o: { kind: TaskKind; agentError: string | null; writeCount: number; completed: boolean },
): { status: "ok" } | { status: "error"; error: string } {
  if (o.agentError) return { status: "error", error: o.agentError };
  if (o.kind === "ner") {
    if (!o.completed) return { status: "error", error: "NER agent did not complete (no result/status)" };
    return { status: "ok" }; // zero spans is a valid empty result
  }
  if (o.writeCount === 0) {
    return { status: "error", error: `agent made no ${primaryWriteTool(o.kind)} writes this run` };
  }
  return { status: "ok" };
}
```

- [ ] **Step 5: Run → PASS; typecheck.** Commit `feat(v2): per-task-kind agent-outcome classification`.

### Task 3.2: wire tally + gate the promote in `runOneAgent`

**Files:** Modify `packages/infra-batch-run/src/runs.ts`.
- Derive `const kind: TaskKind = task.task_kind === "ner" ? "ner" : task.task_kind === "adherence" ? "adherence" : "phenotype";` and `const writeTool = primaryWriteTool(kind);`.
- In each `for await (const event of runAgent(...))` loop (phenotype path ~881 and the ner/adherence path ~1005 — wire BOTH), fold events: `tally = applyAgentEventToTally(tally, event, writeTool)` (init `{agentError:null, writeCount:0, completed:false}`), keep the existing cost accumulation.
- Replace the promote (`if (!fs.existsSync(scratchReviewState)) throw; renameSync(...)`) with: `const outcome = classifyAgentOutcome({ kind, ...tally });` → on `error`, write `agents/<spec.id>.error.json` `{agent_id, status:"error", error}` and return WITHOUT promoting; on `ok`, promote as today. (Mirror light's gate block.)
- Extend `OnePatientOutput` analogue: have `runOneAgent` return `{ status: "ok"|"error", error?, cost_usd, field_count, confidence_summary }` (split `OneAgentOutput` from `OnePatientOutput` like light's `714b102`).
- Steps: read light's `runs.ts` gate block; apply to both run paths; typecheck; `npx vitest run`; commit `feat(v2): fail errored/no-write agents per kind instead of promoting stale drafts`.

### Task 3.3: per-patient rollup + run state

**Files:** `packages/infra-batch-run/src/runs.ts` (mirror light B2 `rollupPatientStatus`).
- Add `rollupPatientStatus(outcomes)` → `failed | complete_with_errors | complete`; `runOnePatient` collects per-spec outcomes, rolls up, returns `patient_status`; the driver records `PerPatientState` (`failed`→`error`) and increments `n_complete`/`n_error`; finalize run state 3-way. Import + stats skip `.error.json` (already in Phase 1/2).
- Test `rollupPatientStatus` (all-fail→failed; mixed→complete_with_errors; all-ok→complete). Commit `feat(v2): roll up per-patient run status from agent outcomes`.

### Task 3.4: UI — surface failures + run-card readiness

**Files:** v2 run-status card + validate views (find the v2 analogues of light's `PhaseTry.tsx` `RunStatusCard` + `PhaseValidate.tsx`).
- Run-status: show `failed` / `complete_with_errors`; suppress the validate affordance on `failed`; **derive readiness from `iter.run_status`, not the persisted `iter.state`** (light's `f09826b` fix — confirm v2 has the same stale-state bug first). Validate view: failed patients non-validatable.
- Test the run-card failed state (mirror light's `RunStatusCard.failed.test.tsx`, adapting prop names). Commit `feat(v2): surface failed/partial runs + run-card readiness from run_status`.

---

## Phase 4 — Client threads `session_id` + migration

### Task 4.1: thread `session_id` through the client

**Files:** v2 workspace + the review/publication/patient-status API calls.
- Read light's `884f462` + `c791d05` (the client session_id threading + App's `chart-review:session-changed` event mirror) as the reference.
- Grep the v2 client for `/api/reviews/`, `/api/performance/`, `/api/patients`, lock/methods/calibration/adherence/span endpoints; append `?session_id=${encodeURIComponent(activeSessionId)}` (or `&`) wherever a session is active; omit when there's no session (patient list before selection). Thread `activeSessionId` by prop into deep components (review surface, NER span editor, adherence form); add the `chart-review:session-changed` event mirror in the top-level App if a call site is on a separate branch.
- Guard: the publication/validate phases require an active session (render a "select a session" state when null).
- Steps: grep + enumerate the call sites in your report; apply; `npm run typecheck`; `npm run build` (client); `npx vitest run`; commit `feat(v2): client passes session_id on review + publication calls`.

### Task 4.2: migration + full-stack verification

- [ ] `rm -rf chart-review-platform-v2/var/reviews` (gitignored).
- [ ] Gates: `npm run typecheck && npx vitest run` (+ `npm run build` if present; + pytest/lib if v2 has one).
- [ ] End-to-end (server running, a configured provider): create session A, run + validate one patient per task kind (phenotype + NER + adherence), confirm `var/reviews/<A>/…` written and a second session B starts empty. For loud-fail: force an agent error (e.g. bad provider creds) and confirm the run shows `failed`, the patient isn't validatable, and no stale draft is promoted. For NER: a note with no entities → the agent completes → status `complete` (NOT failed). LOCK from session A → confirm `locked_from_session` recorded.
- [ ] Commit any verification fixes: `chore(v2): verify session isolation + loud-fail end-to-end`.

---

## Notes for the implementer

- **Read the light sibling** (`../chart-review-platform-light/`) for every "mirror light's X" reference — the code is proven and in the same monorepo; adapt file names.
- **The light lesson that matters most:** count writes from the **AgentEvent stream**, never the SDK PostToolUse hook — for v2's **codex** subprocess provider the hook does not fire (same failure mode as light's deepagents). Task 3.1/3.2 already do this.
- **NER is the one place light's logic can't be copied verbatim:** zero spans + completed = OK; only error / no-completion fails.
- **Typecheck is intentionally red after Task 1.1** at the enumerated `reviewState` call sites; it reaches ZERO after Phase-1/2 close them. Don't "fix" by reverting the seam.
- **Dead `reviewsRoot()` helpers:** after re-pointing a route through the session path, delete any now-unused local `reviewsRoot()` (light hit this twice).
- Run commands from `chart-review-platform-v2/`; git from the monorepo root.
