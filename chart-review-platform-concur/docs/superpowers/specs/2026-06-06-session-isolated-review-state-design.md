# Session-Isolated Review State + Loud-Fail on Agent Error — Design

**Date:** 2026-06-06
**Status:** Approved (pending implementation plan)
**Scope:** chart-review-platform-light

## Goal

Two coupled fixes for one observed bug:

- **A. Session isolation.** Each session gets its own per-patient review state. A
  run/validation in one session can never read or overwrite another session's
  answers for the same patient.
- **B. Loud-fail on agent error.** A run where an agent errors or writes nothing
  must surface as *failed* for that agent — never promote stale/seeded answers as
  if the agent produced them, and never advance a fully-failed patient to
  "ready to validate."

## Motivation (the bug)

Today `review_state.json` is keyed **per-patient-per-task and shared across all
sessions**: `var/reviews/<pid>/<taskId>/review_state.json`. Validation,
performance, export, and patient-status all read this one file.

Observed failure: an earlier session ran gpt-4o on `patient_probable_cytology_01`
and wrote answers to the shared file. Later, session9 ran `llama-3.3-70b` with no
vLLM server; both agents hit `APIConnectionError` and wrote nothing. But the
shared file still held gpt-4o's answers, so the run reported "1/1 drafted →
READY · VALIDATE" and the reviewer validated **the previous session's answers**.

Root causes:
1. **Shared state** — sessions overlap on one file (`var/reviews/<pid>/<taskId>/`).
2. **Silent carry-forward** — `runOneAgent` promotes the scratch `review_state.json`
   whenever the file *exists* (`runs.ts:776`), and `initSession`→`loadOrCreate`
   plus the pilot orchestrator's prior-iteration seeding (`runs.ts:384`) make it
   exist even when the agent wrote nothing. The `error` event from `runAgent` is
   ignored by the run loop (`runs.ts:768`).

## Decisions (locked during brainstorming)

- **Validation scope:** fully per-session. The same patient is reviewed and
  validated independently per session; a human validation in session A does not
  appear in session B.
- **Existing state:** wipe `var/reviews/` as a one-time migration step (dev/test
  data, gitignored).
- **Failure granularity:** per agent. An errored/no-write agent produces no draft.
  If *all* agents for a patient failed → patient is `failed` (not draftable, not
  validatable, shown with the error). If *≥1* agent succeeded → keep the
  successful draft(s), mark the failed agent(s) visibly, and the patient proceeds
  on what succeeded.
- **Within-session carry-forward stays:** the intended criterion-focused merge
  (re-running to refine specific fields within a session) is unchanged. Part B
  only stops an *errored* agent from promoting carried-forward answers as fresh.

## Part A — Session-scoped review state

### The one seam: the review-state path

`review_state.json` moves:

```
before:  var/reviews/<pid>/<taskId>/review_state.json          (shared)
after:   var/reviews/<sessionId>/<pid>/<taskId>/review_state.json   (per session)
```

`pathFor.reviewState(patientId, taskId)` →
`pathFor.reviewState(sessionId, patientId, taskId)` in
`packages/storage/src/index.ts`. This is the single structural change; every
consumer threads `sessionId`.

A session is already task-scoped, so `sessionId` alone disambiguates; `taskId`
stays in the path only for shape continuity with the existing layout.

### Consumers that must thread `sessionId`

| Consumer | File | Change |
|---|---|---|
| Import (run drafts → review_state) | `server/jobs-routes.ts` | Write to the run's *session* path. The session id comes from the iter manifest (`iter.session_id`) for the run being imported. |
| Validate / unvalidate / actions | `server/review-routes.ts` | Accept `session_id` (query param). The VALIDATE UI always has an active session. |
| Performance | `server/performance-routes.ts` | Read `var/reviews/<sessionId>/…` directly. **Removes** the run-id-filtering hack (`sessionRunIds`) added earlier — isolation is now structural. |
| Export | `server/export-routes.ts` | Read the session's review dir for gold answers. |
| Patient status | `server/core-routes.ts` | Look up per-patient `review_status` for the active session. |

### Who creates a session's review_state

The import step (`jobs-routes`) materializes a run's agent drafts into
`var/reviews/<sessionId>/<pid>/<taskId>/review_state.json`, where `sessionId` is
the session that owns the run. A fresh session with no completed run has no
review_state files → performance/validation correctly show nothing.

### Client

The client already tracks `activeSessionId` (Workspace/PhaseValidate/PhaseDecide).
Calls to validate/unvalidate/actions/performance/export pass it through as
`?session_id=`. No new client state; just include the id on the existing calls
that currently omit it.

## Part B — Loud-fail on agent error / no-write

In `packages/infra-batch-run/src/runs.ts` `runOneAgent`:

1. **Capture the error.** While iterating `runAgent(...)`, record whether an
   `event.type === "error"` was seen (and its message) → `agentError: string | null`.
2. **Count real writes.** Count `set_field_assessment` tool calls during *this*
   run via the existing audit hooks (`buildAuditHooks` already sees PreToolUse/
   PostToolUse) → `writeCount`.
3. **Decide:**
   - `agentError !== null || writeCount === 0` → the agent **failed this run**.
     Do **not** rename the scratch into the agent draft. Instead write a failure
     marker `agents/<agent>.error.json` = `{ agent_id, status: "error", error }`
     and return `{ status: "error", error }`.
   - Otherwise promote the draft as today.
4. **Per-patient rollup** (in the patient driver that calls `runOneAgent` per
   spec): collect per-agent results. If *every* agent failed → the patient's run
   status is `failed` (no import, no draft). If *≥1* succeeded → import only the
   successful agents' drafts; the patient proceeds; failed agents are recorded so
   the UI can show them.
5. **Run/iter status.** The run's per-patient status distinguishes
   `complete` / `failed` (all agents failed) / `complete_with_errors` (some
   agents failed). A run whose every patient failed does not become
   READY · VALIDATE.

### UI

- **Run status card** (`PhaseTry.tsx` `RunStatusCard`): show "N drafted · M
  failed" when any agent failed; a fully-failed run shows a failed state, not the
  green "ready to validate" affordance.
- **Agent log** already streams the `error` event — no change needed there beyond
  it now being authoritative (the run no longer hides it).
- **Validate** (`PhaseValidate.tsx`): a `failed` patient is shown as failed and is
  not validatable.

## Migration

One-time, in the implementation: `rm -rf var/reviews/`. It holds only dev/test
data (the stale session9 validation and earlier gpt-4o runs) and is gitignored.
After the change, no code reads the old flat `var/reviews/<pid>/<taskId>/` path.

## Error handling (within this design's own code)

- A malformed/missing iter manifest when resolving a run's `sessionId` at import
  time → the import fails with a clear error naming the run; it does not write to
  an un-scoped path.
- The failure marker write (`agents/<agent>.error.json`) is best-effort; if it
  fails, the run still records the agent failure in the returned status.

## Testing

- **Path seam:** `pathFor.reviewState(sessionId, pid, taskId)` returns
  `…/var/reviews/<sessionId>/<pid>/<taskId>/review_state.json` (unit).
- **Isolation:** writing/validating patient X under session A leaves session B's
  X absent (integration over the storage + review-state read/write helpers).
- **Loud-fail (B):** with the agent provider stubbed to (a) emit an `error` event
  and (b) make zero `set_field_assessment` calls, `runOneAgent` returns
  `status: "error"`, writes no draft, and writes the error marker. A second stub
  that makes ≥1 write promotes a draft normally.
- **Rollup:** all-agents-failed → patient `failed`; one-failed-one-ok → patient
  proceeds on the survivor, failed agent recorded.
- **Performance/export:** read only the active session's dir; a fresh session
  reports nothing (no cross-session leakage).

## Files touched

- `packages/storage/src/index.ts` — `pathFor.reviewState` gains `sessionId`.
- `packages/infra-batch-run/src/runs.ts` — capture error + count writes + per-agent
  failure + rollup; promote only on success.
- `server/jobs-routes.ts` — import writes to the run's session path.
- `server/review-routes.ts` — validate/unvalidate/actions take `session_id`.
- `server/performance-routes.ts` — read session dir; drop the run-id filter hack.
- `server/export-routes.ts` — read session dir.
- `server/core-routes.ts` — patient status per active session.
- `client/src/ui/Workspace/{PhaseValidate,PhaseDecide,index}.tsx` and the review
  API calls — pass `session_id`; show failed patients/agents.
- Tests alongside each.
- One-time `rm -rf var/reviews/`.

## Non-goals

- vLLM reachability probing (a declared vLLM model still shows as available; a
  bad connection surfaces via Part B at run time — which is now honest).
- Changing the within-session criterion-focused carry-forward behavior.
- Migrating old `var/reviews/` data into the new layout (we wipe it).
