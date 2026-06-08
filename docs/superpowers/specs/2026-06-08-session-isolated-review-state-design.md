# Session-Isolated Review State + Loud-Fail (v2 port) — Design

**Date:** 2026-06-08
**Status:** Approved (pending implementation plan)
**Scope:** chart-review-platform-v2

## Goal

Port two correctness fixes proven in chart-review-platform-light back to v2,
generalized to v2's full surface (3 task kinds — phenotype / NER / adherence;
claude + codex providers; all phases including LOCK / DEPLOY / methods /
calibration):

- **Session isolation.** `review_state` becomes per-session so two sessions
  never share a patient's answers. Every consumer — including the publication
  pipeline — operates on a specific session.
- **Loud-fail on agent error.** An errored / no-write agent fails visibly
  instead of silently promoting carried-forward stale answers, with a
  per-task-kind definition of "no real write."

## Motivation

v2 today keys review state as `reviewState(patientId, taskId)` —
`var/reviews/<pid>/<taskId>/review_state.json` — shared across all sessions.
The light bug reproduces in v2: a run in session B inherits session A's stale
validated answers for the same patient. v2's run loop also promotes a scratch
`review_state.json` regardless of whether the agent produced anything this run
(`runs.ts:1032-1036`), and the `error` event from `runAgent` is ignored — so a
crashed/no-write agent silently promotes carried-forward state.

## Decisions (locked in brainstorming)

1. **Full isolation everywhere.** review_state is session-scoped, and the
   **publication pipeline operates on the active session** — the methodologist
   iterates in a session until κ stabilizes, then LOCK / methods / calibration /
   DEPLOY read *that* session's validated review_states. LOCK records which
   session it locked from.
2. **Loud-fail is per task kind** (see §3). NER's "zero spans" is a *valid*
   result, not a failure.
3. **Wipe `var/reviews`** as a one-time migration (gitignored dev/test data).
4. **Phased plan** (§6) — working loop → publication pipeline → loud-fail →
   client — so the ~15–20-file change is reviewable in chunks.

## Part A — Session-scoped review state

### The seam (identical mechanism to light)

`pathFor.reviewState(patientId, taskId)` →
`pathFor.reviewState(sessionId, patientId, taskId)` in
`packages/storage/src/index.ts` (`var/reviews/<sessionId>/<pid>/<taskId>/…`).

Two scoping mechanisms, both already used in v2:
- Domain-review handlers resolve paths via the overridable `reviewsRoot()`
  (AsyncLocalStorage). Wrap each in `withReviewsRoot(sessionReviewsRoot(sid))`
  → internals unchanged.
- Direct-fs callers pass `sessionId` to `pathFor.reviewState`.

New helper `server/lib/session-reviews.ts`: `sessionReviewsRoot(sessionId)` and
`sessionIdForRun(taskId, runId)` (the session a run belongs to, from the iter
manifest's `session_id`) — same as light.

### Consumers — two tiers, all gain `session_id`

**Tier 1 — working loop** (mirrors light's 5):
- `review-routes` — validate / unvalidate / actions / summary / evidence /
  encounters / uiactions / audit reads; plus the **NER span** endpoints
  (`set_span_label`/status, span PATCH/DELETE) and **adherence** endpoints
  (`set_question_answer`, rule verdicts) — all wrapped in `withReviewsRoot`.
- `core-routes` — per-patient `review_status` for the active session.
- `jobs-routes` — import writes drafts under the run's owning session; skips
  `*.error.json` markers.
- `performance` / accuracy reads — read the session's dir.
- run-loop draft promotion (Part B).

**Tier 2 — publication pipeline** (new in v2; each reads the *active/locked*
session): `lock-test-routes`, `methods-routes` + `lib/methods-drafter`,
`ner-calibration-routes`, `adherence-iaa-routes`, `adherence-stats-routes`,
`adherence-summary-routes`, `span-stats-routes`, `proposal-routes`,
`feedback-routes`, `lib/qa-panel`, `lib/methodologist-pdf`. Each gains a
`session_id` input (query param or call arg) and reads
`var/reviews/<sessionId>/…`. LOCK persists the source `session_id` in its lock
record for provenance.

> A consumer that legitimately has no session context (e.g. a pre-session
> patient list) reads no review state and reports none — never the old flat
> path. Same rule as light's core-routes.

### Client

v2's `activeSessionId` is threaded through the workspace. Every review /
performance / publication / patient-status call appends `?session_id=`. Calls
several components deep (the per-patient review surface, NER span editor,
adherence form) receive `activeSessionId` by prop; App mirrors it via the same
`chart-review:session-changed` event used in light when the call site is on a
separate component branch.

## Part B — Loud-fail, generalized per task kind

In the run loop (`packages/infra-batch-run/src/runs.ts`), for each agent:

1. **Capture** the `error` event from `runAgent` (currently ignored).
2. **Count the kind's primary write** from the provider-agnostic AgentEvent
   stream (`event.type==="tool_use"`) — works for claude **and** codex (the
   SDK PostToolUse hook does not fire for the codex subprocess, exactly the
   light deepagents lesson):
   - phenotype → `set_field_assessment`
   - adherence → `set_question_answer`
   - NER → `set_span_label`
   Also track whether a **completion signal** (`set_review_status` or a
   `result` event) was seen.
3. **Classify per kind:**
   - **any kind:** `error` event → **fail**.
   - **phenotype / adherence:** zero primary writes → **fail** (every leaf
     field / question must be answered).
   - **NER:** zero spans is **OK** when a completion signal was seen (a note
     with no entities is a valid result); fail only on `error` or **no
     completion signal at all**.
4. **Gate the promote:** on fail, write `agents/<id>.error.json` marker, do
   NOT promote the scratch (it may hold carried-forward state); on success,
   promote as today.
5. **Per-patient rollup:** all agents failed → patient `failed`; some failed →
   `complete_with_errors`; all ok → `complete`. Run state derives 3-way
   (matching v2's existing `RunState`). Import + stats skip `.error.json`.

### UI
Run-status surfaces `failed` / `complete_with_errors` (no false "ready to
validate"); the validate views render failed patients as non-validatable;
readiness derives from the live `run_status`, not the persisted iter `state`
(the light run-card fix).

## Migration + back-compat

One-time `rm -rf chart-review-platform-v2/var/reviews`. New layout starts empty;
no code reads the old flat path afterward. Iters without a `session_id` (legacy)
resolve to "no session" → empty publication reads, never the flat path.

## Error handling (within this change)

- Resolving a run's `sessionId` at import time fails with a clear error naming
  the run if the iter has no owning session (no un-scoped writes).
- `.error.json` marker writes are best-effort; the agent failure is still
  recorded in the returned status regardless.
- Malformed session/run manifests surface a clear error rather than crashing.

## Testing

- **Loud-fail per kind:** phenotype/adherence (0 writes → fail; ≥1 → ok); NER
  (0 spans + completion → **ok**; error → fail; no completion → fail). Driven by
  a pure `classifyAgentOutcome`-style fn + an event-stream tally fn, tested with
  each kind's event shapes (the path that escaped review in light).
- **Path seam:** `pathFor.reviewState(sessionId, pid, taskId)`.
- **Isolation:** validating patient X in session A leaves session B empty;
  NER spans / adherence answers land under the session.
- **Publication:** lock / methods / κ read the active session's review_states;
  a fresh session publishes nothing; LOCK records the source session.
- **Rollup:** all-fail → failed; mixed → complete_with_errors.

## Files touched (by phase)

- **Phase 1 (working loop):** `packages/storage`, `server/lib/session-reviews.ts`
  (new), `server/review-routes.ts`, `server/core-routes.ts`,
  `server/jobs-routes.ts`, `server/performance`/accuracy routes.
- **Phase 2 (publication):** `lock-test-routes`, `methods-routes` +
  `lib/methods-drafter`, `ner-calibration-routes`, `adherence-*-routes`,
  `span-stats-routes`, `proposal-routes`, `feedback-routes`, `lib/qa-panel`,
  `lib/methodologist-pdf`.
- **Phase 3 (loud-fail):** `packages/infra-batch-run/src/runs.ts` + UI
  (run-status card, validate views) + the run-card readiness fix.
- **Phase 4 (client):** workspace + the review/publication API calls thread
  `session_id`; App's `chart-review:session-changed` mirror.
- One-time `rm -rf var/reviews`.

## Non-goals

- Per-agent model registry / Azure-vLLM mixing — light-specific (v2 is
  claude/codex); a separate later port.
- Changing within-session criterion-focused carry-forward (it stays; loud-fail
  only stops an *errored* agent from promoting it as fresh).
- The deployment runner — the next feature in the program, not this one.
