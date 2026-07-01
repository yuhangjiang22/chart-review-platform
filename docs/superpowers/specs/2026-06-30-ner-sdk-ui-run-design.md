# UI trigger for the vendored Claude-Agent-SDK NER run (bso-ad-ner-sdk)

**Date:** 2026-06-30
**Status:** design — approved in brainstorming, not yet implemented
**Scope:** Add a UI affordance so a reviewer can run the vendored `bso-ad-ner-sdk` pipeline from the NER tab (not the command line). Dedicated channel; does not touch the platform's pilot/batch-run core or other tasks.

> **STANDING INSTRUCTION — DO NOT COMMIT.** All changes stay local.

## Why

Layer B made the vendored SDK pipeline runnable via the CLI `scripts/run-bso-ad-claude-sdk.ts`. The platform's existing TRY "Run" button POSTs `/api/pilots/:taskId`, which runs the **deepagents** provider — NOT our vendored Claude-Agent-SDK runner. So there is no UI path to our pipeline today. This adds one.

## Decisions (brainstorming, 2026-06-30)

1. **Dedicated channel** (not the pilot/batch path): a new `POST /api/ner-sdk/run` + `GET /api/ner-sdk/run-status`, and a NER-only button in `PhaseTry`. No change to `infra-batch-run` / the provider abstraction / other tasks.
2. **Background + progress polling:** the button kicks off a background run, returns immediately; the UI polls a status file and shows `done/total` patients; on completion it offers VALIDATE.
3. Runs only for the NER task(s) — gated on `taskKind === "ner"`.

## Verified facts (2026-06-30)

- Route pattern: a `server/*-routes.ts` exports `export const xRoutes: RouteEntry[] = [{ method, pattern, handler: async (body, req, params, query) => …}]`; registered in `server/index.ts` by an import + `...xRoutes` in the routes array (~line 222).
- The CLI `scripts/run-bso-ad-claude-sdk.ts` already does preflight (vendor layout + proxy reachable + session/cohort) → `runBenchmarkCohort` → writes per-patient `review_state` under the session, and prints `[run] …` / `[done] <patientId>: …` / a final `[sdk-run] done: …`.
- `runBenchmarkCohort({…, onProgress})` calls `onProgress` with `[done] <patientId>: <n> spans, <m> failed notes` once per patient — enough to drive a `done/total` counter without changing the lib.
- The platform's existing TRY run uses a detached/async run + a 4s poll of `/api/pilots/:taskId` + `RunStatusCard`; we mirror the *shape* (kick off → poll → card) with our own endpoints.
- bso-ad-ner-sdk has `session_001` (cohort = 5 `patient_real_*`); the corpus patients + their notes exist.

## Architecture

```
PhaseTry (NER branch)                         server                              vendored CLI (detached)
─────────────────────                         ──────                              ───────────────────────
[Run via Claude Agent SDK]  ── POST ──▶  /api/ner-sdk/run {session_id}
                                              │ spawn detached:
                                              │   npx tsx scripts/run-bso-ad-claude-sdk.ts
                                              │     --session-id <s> --status-file var/benchmark-sdk/<s>/status.json
                                              │ return { started:true, n_patients } immediately
   poll every 4s ── GET ──▶  /api/ner-sdk/run-status?session_id=<s>  ── reads ──▶  status.json  ◀── written by CLI
   render done/total + failures                                                    (running → complete)
   on complete → [Go to VALIDATE]
```

### Components

1. **CLI `scripts/run-bso-ad-claude-sdk.ts` (modify)** — add `--status-file <path>`:
   - Before the run: write `{ state:"running", session_id, total: patientIds.length, done:0, started_at:<iso>, failures:[] }`.
   - In `onProgress`: when a message matches `/^\[done\] /`, increment `done` and rewrite the status file (atomic: write tmp + rename). (Still also `console.log` for the detached log.)
   - After `runBenchmarkCohort`: write `{ state:"complete", session_id, total, done, n_spans, failed_notes, finished_at }`.
   - On preflight/throw: write `{ state:"error", message }` then exit non-zero. (When `--status-file` is absent, behave exactly as today — backward compatible.)

2. **`server/ner-sdk-run-routes.ts` (create)** — `export const nerSdkRunRoutes: RouteEntry[]`:
   - `POST /api/ner-sdk/run` — body `{ session_id }`. Validate it's a string. Status path = `<PLATFORM_ROOT>/var/benchmark-sdk/<session_id>/status.json`; log path alongside (`run.log`). `mkdir -p` the dir; write an initial `{state:"starting"}`. `spawn("npx", ["tsx", "scripts/run-bso-ad-claude-sdk.ts", "--session-id", session_id, "--status-file", statusPath], { cwd: PLATFORM_ROOT, detached:true, stdio:["ignore", logFd, logFd] })` then `child.unref()`. Return `{ started:true, session_id }`. (No `await` — fire-and-forget; the CLI owns the run.)
   - `GET /api/ner-sdk/run-status?session_id=…` — read the status file; if missing return `{ state:"idle" }`; else parse + return it.
   - Guards: reject empty/invalid `session_id`; sanitize it into the path (no `/`/`..`).

3. **`server/index.ts` (modify)** — import `nerSdkRunRoutes` + add `...nerSdkRunRoutes,` to the routes array.

4. **`client/src/ui/Workspace/PhaseTry.tsx` (modify)** — in the NER branch only (`taskKind === "ner"`):
   - Render a primary button **"Run via Claude Agent SDK"** (in place of, or above, the deepagents "Run" for NER). On click: `POST /api/ner-sdk/run {session_id: activeSessionId}`, set local `running` state.
   - While running: poll `GET /api/ner-sdk/run-status?session_id=…` every 4s; render `Running… {done}/{total} patients` (+ failures count if any).
   - On `state==="complete"`: show `Done — {n_spans} spans` + a **"Go to VALIDATE"** button (calls the existing `onAdvanceToValidate`).
   - On `state==="error"`: show the message (e.g. "proxy not reachable …").
   - Gate the button on `activeSessionId` (else prompt to pick a session).

### Status file shape (`var/benchmark-sdk/<session_id>/status.json`)
```json
{ "state": "starting|running|complete|error",
  "session_id": "session_001", "total": 5, "done": 3,
  "n_spans": 0, "failed_notes": 0, "failures": [],
  "started_at": "…", "finished_at": "…", "message": "" }
```
`var/` is gitignored, so status/logs never enter git.

## Boundaries / non-goals

- No change to `infra-batch-run`, the agent-provider abstraction, the pilot/iter machinery, or any non-NER task.
- The button shows only for NER tasks; phenotype/adherence keep the existing deepagents Run untouched.
- No live token-stream; coarse `done/total` polling is the MVP (matches the deferred-follow-on scope).
- Auth: reuse whatever `authFetch` already sends; the route does no extra auth beyond the platform default.

## Testing

- **CLI:** `--status-file` writes `starting`→`running`(done increments)→`complete`; absent flag → unchanged behavior (existing unit tests + preflight smoke still green).
- **Route (unit/integration):** POST returns `{started:true}` and creates `var/benchmark-sdk/<s>/status.json`; GET returns the file's JSON, or `{state:"idle"}` when absent; invalid `session_id` → 400.
- **Frontend:** button appears only when `taskKind==="ner"`; clicking POSTs + begins polling; status `complete` reveals the VALIDATE button. (Component test mirrors existing `PhaseTry.test.tsx` patterns; mock `authFetch`.)
- **E2E (owner, proxy up):** click Run on `bso-ad-ner-sdk` / `session_001` → progresses 0/5→5/5 → spans appear in VALIDATE. (Spends real gpt-5.2; owner-run.)

## Self-review

- Placeholders: none — route pattern, status shape, spawn flags, button states all concrete.
- Consistency: status path `var/benchmark-sdk/<session_id>/status.json` used by CLI writer + both routes + frontend poll; `taskKind==="ner"` gate matches the PhaseTry fix already in place.
- Scope: additive (1 new route file + 1 CLI flag + 1 index import + NER-branch UI); no core/other-task changes.
- Ambiguity: progress granularity = per-patient via `[done]` parse (no lib change) — explicit.
