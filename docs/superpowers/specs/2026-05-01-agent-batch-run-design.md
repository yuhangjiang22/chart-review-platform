# Agent Batch-Run Primitive — Design

**Date:** 2026-05-01
**Issue:** Vibe chart review fix #9
**Status:** ready for implementation plan

## Goal

A server-side primitive that runs the chart-review agent across N patients with the active guideline, persists each per-patient draft as an immutable artifact, and surfaces progress + results for human validation. The same agent primitive used by the chat copilot, but driven from a queue rather than a chat message.

This unblocks the "vibe chart review" workflow: agent does the bulk of the per-patient draft, humans validate at the queue level (#10), pilot iterations cycle without per-patient hand-driving (#11), and self-critique can read the run as a whole (#12).

## Non-goals

- Validation queue UI (#10), pilot lifecycle (#11), self-critique (#12), guideline maturity (#13) — separate issues that consume this primitive.
- Scheduling / auto-fire on assignment — explicit POST trigger only for v1.
- Direct rewrites of `reviews/<pid>/<task>/review_state.json` — out of scope; see "Side-channel only" below.
- Changes to the chart-review skill itself — v1 reuses the existing skill with a batch-mode hint in the user prompt.

## Architecture

### Data model

A run is a directory tree under `runs/<run_id>/`:

```
runs/<run_id>/
  manifest.json                         # immutable run-level provenance
  status.json                           # mutable; updated as patients complete
  per_patient/<patient_id>/
    agent_draft.json                    # review_state.json shape (read-compatible)
    audit.jsonl                         # tool_use + assistant message events
    error.txt                           # only present if this patient failed
```

`run_id` is an ISO timestamp (e.g. `2026-05-01T14-22-09-321Z`) with `:` and `.` replaced by `-`. An optional `label` (kebab-case, e.g. `pilot-iter-3`) is recorded in `manifest.json` but does NOT appear in the path.

### `manifest.json` shape

```json
{
  "run_id": "2026-05-01T14-22-09-321Z",
  "label": "pilot-iter-3",
  "task_id": "lung-cancer-phenotype",
  "guideline_sha": "<computeTaskSha at run start>",
  "started_at": "2026-05-01T14:22:09.321Z",
  "started_by": "dr_lee",
  "patient_ids": ["pt_001", "pt_007", "pt_023", ...],
  "max_concurrency": 3,
  "max_turns_per_patient": 30,
  "model": "claude-opus-4-7",
  "cost_cap_usd": 50,
  "kind": "agent_batch_run"
}
```

### `status.json` shape

```json
{
  "run_id": "2026-05-01T14-22-09-321Z",
  "state": "running" | "complete" | "complete_with_errors" | "aborted_cost_cap" | "failed",
  "started_at": "2026-05-01T14:22:09.321Z",
  "updated_at": "2026-05-01T14:24:55.102Z",
  "completed_at": null,
  "total_cost_usd": 1.84,
  "n_patients": 50,
  "n_complete": 17,
  "n_error": 1,
  "n_running": 3,
  "per_patient": {
    "pt_001": { "state": "complete", "duration_ms": 41203, "cost_usd": 0.043, "field_count": 11 },
    "pt_007": { "state": "complete", "duration_ms": 36571, "cost_usd": 0.038, "field_count": 11 },
    "pt_012": { "state": "running",  "started_at": "2026-05-01T14:24:30.000Z" },
    "pt_017": { "state": "error",    "error": "agent timed out at maxTurns=30" },
    "pt_023": { "state": "pending" }
  }
}
```

State transitions: `pending → running → (complete | error)`. Status writes are atomic — driver writes to a temp file then renames. Any reader sees a consistent snapshot.

### `agent_draft.json` shape

Identical to `review_state.json` so the validation queue (#10) can re-use existing rendering. Distinguishing fields:

```json
{
  "patient_id": "pt_007",
  "task_id": "lung-cancer-phenotype",
  "lock_task_sha": "<frozen guideline_sha from manifest>",
  "version": 1,
  "review_status": "agent_drafted",
  "updated_by": "agent",
  "updated_at": "...",
  "field_assessments": [...],
  "selected_evidence": [...],
  "summary": "...",
  "_run_id": "2026-05-01T14-22-09-321Z"
}
```

`review_status: "agent_drafted"` is a new sentinel value that will not appear in normal `reviews/<pid>/<task>/review_state.json` files; the validation queue uses it to filter.

## Side-channel only — never overwrite reviews/

The driver writes only under `runs/`. The reviewer's `review_state.json` is sacred. Promotion from agent_draft to review_state is the validation queue's explicit job (#10) — out of scope here.

Rationale: re-runs at a new guideline SHA, A/B comparison across runs, and locked-record safety all become trivial. The asymmetry of "direct write if no prior state, side-channel otherwise" creates surprise that costs more than the one-click import in #10.

## Concurrency + failure handling

- **Bounded parallelism.** A semaphore wraps `query()` calls. Default `max_concurrency: 3`, configurable per-run via the API. Each in-flight patient holds one slot.
- **Continue-on-error.** Per-patient failures (timeout, model error, MCP write rejection) write `error.txt` and `per_patient[pid].state = "error"`; the run keeps going. Final state is `complete_with_errors` if any errored, `complete` otherwise.
- **Cost cap.** Driver tracks cumulative `total_cost_usd` from SDK `result.total_cost_usd`. When cumulative exceeds `cost_cap_usd` (default $50, env-configurable), the driver stops scheduling new patients; in-flight patients finish, status transitions to `aborted_cost_cap`. Already-completed work is preserved.
- **No retry in v1.** Reviewer-triggered "retry failed patients" via a separate endpoint is a follow-up.

## Streaming / progress

Two complementary mechanisms, both reading the same source of truth (`status.json`):

1. **Polling.** UI can `GET /api/runs/<run_id>/status` whenever it likes — cheap, stateless, survives every disconnect.
2. **WebSocket broadcast.** After each `status.json` write, the server broadcasts `{ type: "agent_run_update", run_id, status }` on the existing `/ws` channel. UI clients subscribe in `useAgentSocket` (extend it) and update live. Re-mounted UI re-reads `status.json` once and is current.

No SSE, no separate channel.

## Guideline SHA frozen at run start

`manifest.guideline_sha` is computed once via `computeTaskSha(guidelineDir(task_id))` when the run is created. Every per-patient `composeAgentOptions({ guidelinePath })` call uses the same path; if someone edits the guideline mid-run, the agent still sees the version it was scheduled against. (Reading happens at agent runtime, so a mid-run guideline edit could in principle leak through; in practice the run is short and the methodologist surface won't let edits land mid-run for a non-trivial-cohort task. We accept this limit; the SHA in manifest still gives auditable provenance.)

## API surface

```
POST /api/runs
  body: {
    task_id: string,
    patient_ids: string[],
    label?: string,
    max_concurrency?: number,    // default 3
    max_turns_per_patient?: number,  // default 30
    cost_cap_usd?: number        // default $50
  }
  response: { run_id, manifest } (synchronous; the run itself is async)

GET /api/runs                   # list runs (newest first), optionally filtered by ?task_id=
GET /api/runs/<run_id>          # manifest
GET /api/runs/<run_id>/status   # status.json
GET /api/runs/<run_id>/patients/<patient_id>/draft   # agent_draft.json
GET /api/runs/<run_id>/patients/<patient_id>/audit   # audit.jsonl, line-stream
DELETE /api/runs/<run_id>       # delete a completed run (cleanup; refuses while running)
```

WebSocket message:

```json
{ "type": "agent_run_update", "run_id": "...", "status": { /* status.json */ } }
```

## Agent invocation per patient

```ts
composeAgentOptions({
  cwd: patientDir(patientId),                       // notes scope
  patientId,
  taskId,
  guidelinePath: guidelineDir(taskId),
  mcpServers: { review_state: makeRunMcpServer(runId, patientId) },
  extraTools: [],                                   // no extra tools beyond defaults + MCP
  maxTurns: manifest.max_turns_per_patient,
  permissionMode: "acceptEdits",
  extraSystemPrompt:
    "You are running in batch mode. Activate the chart-review skill. " +
    "You have one shot for this patient — read the notes, draft assessments " +
    "for every leaf criterion with evidence offsets, write via mcp_review_state " +
    "tools. After all fields are answered, you are done. Do not chat with a " +
    "human; emit your draft and finish.",
})
```

The MCP server `review_state` is run-scoped: writes go to `runs/<run_id>/per_patient/<pid>/agent_draft.json` instead of `reviews/<pid>/<task>/review_state.json`. Same wire format as the existing in-process MCP server, different sink. This means the chart-review skill needs zero changes for v1 — it calls the same MCP tool names, the server routes them.

Tool-use events are mirrored to `runs/<run_id>/per_patient/<pid>/audit.jsonl` so reviewers can inspect the agent's reasoning later.

## Implementation outline

1. **`runs.ts` driver** (~300 lines):
   - `startBatchRun(opts) → { run_id, manifest }` — validates inputs, creates manifest+status, kicks off async loop, returns immediately.
   - Async loop reads pending patients, schedules them via the semaphore, awaits each, updates `status.json` atomically, broadcasts on WS, enforces cost cap, finalizes when done.
   - `getRunManifest`, `getRunStatus`, `listRuns`, `deleteRun` — read helpers.
2. **`run-mcp.ts`** — wraps the existing review-state MCP server (`mcp__review_state__*` tools) with a per-run output sink. Rebinds `set_field_assessment`, `select_evidence`, `set_review_summary`, etc. to write into `runs/<run_id>/per_patient/<pid>/agent_draft.json` instead of `reviews/<pid>/<task>/review_state.json`.
3. **`server.ts`** — register the routes above. Mount under `authMiddleware()`. Permission gate: starting a run requires `isMethodologist(reviewer_id)` (reuse #8's helper).
4. **WS plumbing** — extend `useAgentSocket` to handle `agent_run_update`, store latest status in a `Map<run_id, status>`. Run-list and per-run pages consume it.
5. **`runs/` in .gitignore** — runs are reproducible, large, and patient-data-sensitive. Already ignored from the cleanup-2 era.

## Test approach

- **Unit-ish:** `runs.ts` driver tested with a fake `query()` that produces deterministic per-patient outputs. Verifies semaphore behavior, error continuation, cost-cap abort, status.json atomicity.
- **Integration:** `seedSkillBundle` + a minimal guideline + 3 fake patients with notes; run `startBatchRun` with `max_concurrency: 2`; assert all three drafts land in the run dir, status finishes `complete`, audit.jsonl has at least one entry per patient.
- **No live LLM tests** — those are deferred to a separate suite.

## Provenance + reproducibility

`manifest.json` captures everything needed to re-run a batch: `task_id`, `guideline_sha`, `patient_ids`, `model`, `max_turns`, `cost_cap`, `started_by`. The reproducibility-bundle action (#19) can later snapshot a run dir verbatim into the bundle without further work.

## Permissions

Starting a run is methodologist-only (see #8). Reading a run's status/drafts is allowed for any authenticated reviewer (so reviewers can see what the agent drafted on their assignments). Deleting is methodologist-only.

## Cost notes

A 50-patient run at typical 30-turn budgets ≈ $5-15 with current Claude pricing. The default `cost_cap_usd: 50` is generous; real PI-controlled caps will likely be tighter (set via the API per-run).

## Open questions / follow-ups

- **Re-run identity.** If `pt_017` errored in run A, the user retries in run B with `patient_ids: ["pt_017"]`. There's no automatic linkage — both runs exist independently. Acceptable for v1; #10 (validation queue) can present "all drafts for pt_017 across runs".
- **Audit fidelity.** v1 logs tool_use events and assistant messages. We don't capture the agent's intermediate "thinking" tokens — the SDK doesn't expose them in `result` events. If we want full transcripts later, capture during the stream.
- **Per-patient timeout.** `maxTurns` is the only stop signal. A pathological infinite-loop could pin a worker. Real timeout (wall-clock per patient) is a follow-up; for now `maxTurns: 30` is the de-facto cap.
- **Skill divergence.** If batch-mode behavior needs significantly different prompting from interactive chat, fork to a sibling skill `chart-review-batch`. Track in #9 follow-up if it surfaces.
