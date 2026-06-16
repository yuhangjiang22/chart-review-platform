# Running the app (chart-review-platform-concur)

How to set up and start the concur app locally.

## Prerequisites

- **Node** (for the server + client) and **npm**.
- **Python ≥ 3.11** + **uv** (for the deepagents sidecar that runs the agents).
- An LLM backend: **Azure OpenAI** (HIPAA-eligible, e.g. `gpt-4o`) and/or **vLLM /
  OpenRouter** (e.g. `qwen3-32b`, `claude-sonnet`).

## 1. Configure environment

```sh
cp .env.example .env
```
Fill in `.env` (it is gitignored — never commit it). Key vars (see `.env.example`
for the full list):

- `AGENT_PROVIDER=deepagents`, `MCP_TRANSPORT=subprocess`
- `DEEPAGENTS_PYTHON` — absolute path to the sidecar venv's python (set in step 2)
- `DEEPAGENTS_LLM_BACKEND=azure|vllm`
- `AZURE_OPENAI_*` (API key, endpoint, version, deployment) and/or `VLLM_BASE_URL`
  / `VLLM_MODEL` / `VLLM_API_KEY`
- `CHART_REVIEW_PLATFORM_ROOT` — absolute path to this checkout
- `CHART_REVIEW_PHI_MODEL=gpt-4o` — PHI patients route here (a HIPAA-eligible
  model), never the default backend
- `CHART_REVIEW_RUCAM_DATA_DIR` — absolute path to a RUCAM CSV cohort (only for
  the RUCAM task; e.g. `$(pwd)/corpus/rucam-synth`)

## 2. Build the Python sidecar

```sh
cd python
uv venv .venv --python 3.11
uv pip install -e .                 # deepagents, langchain, pandas, openpyxl
cd ..
```
Then point `DEEPAGENTS_PYTHON` in `.env` at `python/.venv/bin/python` (absolute).

## 3. Install JS deps + start

```sh
npm install
npm run dev          # server + client, hot reload
```
- Server (API + WebSocket): **http://localhost:3002**
- Client UI: the dev client URL printed by Vite (e.g. **http://localhost:5174**)

Open the client, pick a task (cancer-diagnosis / asthma-adherence / bso-ad-ner /
rucam), start a session, and run an iteration (TRY).

### RUCAM note
RUCAM needs its CSV cohort wired in — start with the var set:
```sh
CHART_REVIEW_RUCAM_DATA_DIR="$(pwd)/corpus/rucam-synth" npm run dev
```
and use a capable agent model (`claude-sonnet` / `gpt-4o`); see
`docs/rucam-test-guide.md`.

## Common commands

```sh
npm run dev            # dev server (hot reload)
npm run typecheck      # tsc --noEmit
npm run build:client   # build the client
npx vitest run --reporter=dot                 # JS tests
cd python && ./.venv/bin/python -m pytest -q  # Python tests (needs pytest in the venv)
```

## Notes / gotchas

- The agents run via the Python sidecar (one langchain-mcp session per patient
  run); the TS server talks to it as a subprocess. If runs error immediately,
  check `DEEPAGENTS_PYTHON` points at the venv and the backend creds are set.
- The server reads the rubric from `.claude/skills/` (the one canonical tree).
- Concurrent runs are capped by `CHART_REVIEW_MAX_CONCURRENCY` (default 3).
- This repo is **local-only** by policy (see CLAUDE.md). Do not commit `.env`.
