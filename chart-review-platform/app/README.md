# chart-review-platform / app

The chart-review platform's **conversational reviewer UI**. Sits inside `chart-review-platform/` next to the Python `lib/`, sharing the same `corpus/`, `tasks/`, `contracts/`, and `runs/` directories. Both halves talk through files; this folder is the Node + React side.

Built on top of the [`simple-chatapp` demo](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/simple-chatapp) and merged with the existing platform — both the agent and the reviewer write to the same `review_state.json` (filesystem-as-state).

## What's inside

```
chart-review-platform/
├── corpus/              ← 20-patient research corpus (shared with Python)
├── tasks/
│   ├── lung_cancer_phenotype.md
│   └── compiled/
│       └── lung_cancer_phenotype.json   ← compiled task the app loads
├── contracts/
│   ├── compiled_task.schema.json
│   ├── review_record.schema.json
│   ├── evidence.schema.json
│   ├── trace.schema.json
│   └── review_state.schema.json         ← live mutable per-patient×task state
├── reviews/             ← <patient_id>/<task_id>/review_state.json (mutable, gitignored)
├── runs/                ← per-batch ReviewRecord JSON (immutable, gitignored)
├── lib/                 ← Python: parser/validator/derivation/agents/CLI
└── app/                 ← THIS — Node/Express/React/Tailwind chat UI
    ├── server/
    │   ├── server.ts        HTTP + WS endpoints
    │   ├── session.ts       per-patient agent session
    │   ├── ai-client.ts     Claude Agent SDK invocation; cwd locked to patient
    │   ├── tasks.ts         load tasks/compiled/<task_id>.json
    │   ├── patients.ts      enumerate corpus + read notes
    │   ├── review-state.ts  reviews/<pid>/<tid>/review_state.json (atomic + concurrency)
    │   ├── faithfulness.ts  TS port of chart_review.faithfulness
    │   ├── mcp-tools.ts     in-process MCP server: set_field_assessment, get_review_state
    │   ├── batch-bridge.ts  spawn the Python `chart-review batch` CLI
    │   ├── chat-store.ts    in-memory chat history
    │   └── types.ts
    ├── client/
    │   ├── index.html
    │   └── src/
    │       ├── App.tsx          3-pane layout + WS hook (lifted)
    │       ├── PatientList.tsx
    │       ├── NoteViewer.tsx   tabs: <date> note(s) | task | review form
    │       ├── TaskView.tsx     compiled-task field tree
    │       ├── ReviewForm.tsx   field cards + reviewer overrides + formal-run button
    │       ├── ChatPanel.tsx
    │       ├── useAgentSocket.ts  WS subscribe + review_state streaming
    │       └── types.ts
    └── scripts/             smoke-chat.mjs (chat WS), smoke-mcp.mjs (set_field_assessment), smoke-merged.py (Playwright UI), smoke-ui.py
```

## What you see in the UI

Three panes:

- **Left:** patient list (20 corpus patients with category + difficulty pills + headlines).
- **Middle:** tabbed pane — clinical notes by date, **Task** (the compiled protocol with one card per field, gates and derivations called out), **Review form** (field-by-field state bound to `review_state.json`, with a per-row "set answer / approve / override" affordance and a **▶ run formal review** button that bridges to the Python batch runner).
- **Right:** AGENT chat panel (WebSocket; tool-call traces + assistant bubbles; "connected" pill).

Two state files per patient×task:

- **`reviews/<pid>/<tid>/review_state.json`** — mutable, version-counter-protected, written by both the agent (via the in-process MCP `set_field_assessment` tool) and the reviewer (via the UI's PATCH-style action endpoint).
- **`runs/<run_id>/<pid>.json`** — immutable per-run ReviewRecord produced by the Python batch runner, surfaced inline by the "run formal review" button.

## Quick start

```sh
cd chart-review-platform/app
cp .env.example .env
# then edit .env — fill in ANTHROPIC_AUTH_TOKEN with your OpenRouter API key
npm install
npm run dev
```

This starts the Express + WebSocket backend on `http://localhost:3001` and the Vite dev frontend on `http://localhost:5173` (which proxies `/api` and `/ws` to the backend).

Open `http://localhost:5173` in a browser.

### Model routing (OpenRouter)

The agent talks to a model via OpenRouter's Anthropic-compatible endpoint. Configured via env (already in `.env.example`):

```
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=<your OpenRouter key>
ANTHROPIC_API_KEY=
CHART_REVIEW_MODEL=anthropic/claude-haiku-4.5
```

Verified models (smoke-tested 2026-04-29):

- `anthropic/claude-haiku-4.5` — best speed / cost / reliability with the full MCP tool surface. Default.
- `anthropic/claude-sonnet-4.6` — recommended for adjudication-quality reasoning.
- `deepseek/deepseek-v4-pro` — verified working with the full 6-tool MCP surface after the evidence-schema flattening (see "Provider compatibility notes" below). ~3-4× slower than Haiku; ~2× cost; reasoning is solid.
- `deepseek/deepseek-v4-flash` — should work via the same code path; not separately re-tested at this surface.

### Provider compatibility notes

**DeepSeek via OpenRouter is routed through Together AI**, whose request-schema validator rejected our original `select_evidence` / `set_field_assessment` schemas. The cause was Zod's `z.union([noteEvidence, omopEvidence])` translating to JSON Schema `anyOf` at the parameter level, which Together's validator does not accept. The fix (committed) was to flatten the evidence schema to a single object with `source` as an enum and every per-source field optional, with runtime discrimination in the tool handler. No information loss; same on-disk shape; passes both Anthropic and Together schema checks.

`scripts/diagnose-model.mjs` is the smoke that captures the full upstream error verbatim — useful when bringing up a new provider.

Swap models by editing `CHART_REVIEW_MODEL` in `.env` and restarting the backend.

## API surface

- `GET  /api/patients`
- `GET  /api/patients/:id/notes`
- `GET  /api/patients/:id/notes/:filename`
- `GET  /api/tasks`
- `GET  /api/tasks/:id` — full compiled task
- `GET  /api/reviews/:pid/:tid` — load (or create) review_state.json
- `POST /api/reviews/:pid/:tid/actions` — reviewer-side state mutation (same shape as the agent's MCP tool)
- `POST /api/review/run` — spawns `chart-review batch ...` via Python; returns the formal ReviewRecord
- `GET  /api/patients/:id/messages` — chat history

WebSocket on `ws://localhost:3001/ws`:

- inbound: `subscribe` / `chat`
- outbound: `connected` / `history` / `user_message` / `assistant_message` / `tool_use` / `result` / `review_state_update` / `error`

## Smoke tests

```sh
# 1. start the server (or `npm run dev`)
node scripts/smoke-chat.mjs patient_easy_nsclc_01 "Summarize this patient."
node scripts/smoke-mcp.mjs                                 # exercises set_field_assessment
python scripts/smoke-merged.py                             # full Playwright UI smoke
```

`smoke-merged.py` exercises all four slices in one run — patient list / notes-task-review tabs / agent records via MCP / formal-run bridge — and saves screenshots to `/tmp/chart-review-merged-screens/`.

## Architecture notes

- **Filesystem-as-state.** Both the agent (via MCP) and the reviewer (via REST) write to the same `review_state.json`. The UI subscribes to the same patient-keyed WebSocket; `review_state_update` events broadcast atomically after every successful write.
- **Faithfulness pre-check at the gateway.** Every note-quote evidence row is verified (whitespace-tolerant) against the source note before persistence. Failures abort the write — neither the agent nor the reviewer can record an answer cited to text that doesn't exist at the claimed offsets.
- **Optimistic concurrency.** `review_state.json` carries a monotonic `version` field; writes that pass an explicit expected version are rejected on mismatch (the chat path increments unconditionally).
- **Cross-language bridge.** The "▶ run formal review" button spawns the Python `chart-review batch` CLI as a subprocess, awaits it, then reads `runs/<run_id>/<pid>.json` and returns it inline. Two halves of the platform never share memory; they coordinate through the filesystem.

## What's NOT here (yet, deliberately)

- Audit-trail emission via PreToolUse/PostToolUse hooks.
- Authoring agent (Role A) and Feedback agent (Role C).
- Full action-protocol with typed `ui_action` envelopes — current MCP surface is one tool (`set_field_assessment`); more will follow.
- Multi-task picker — server only ships `lung_cancer_phenotype` today; UI auto-selects the first compiled task.
- Reviewer authentication.

## Production considerations (per the upstream demo)

These apply here too. They are **not addressed** in this version:

1. **Isolation.** The SDK has access to Read/Glob/Grep + the in-process MCP tools. In production, run the SDK in a sandboxed container or restricted user account.
2. **Persistent storage.** `chat-store.ts` is in-memory; chats are lost on restart. `review_state.json` IS persisted on disk — that's deliberately the durable surface.
3. **Authentication.** None. Anyone hitting `localhost:3001` can chat about any patient.
4. **PHI.** The corpus is synthetic. Do not point this at real EHR data without addressing 1–3 plus institutional BAA / IRB review.
