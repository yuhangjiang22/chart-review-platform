# chart-review-platform-light

A trimmed fork of chart-review-platform-v2, reduced to the minimum viable
stack for a single phenotype chart-review task driven by an open-weights or
Azure OpenAI model via the [deepagents](https://github.com/langchain-ai/deepagents)
agent framework.

---

## What it is

- **One task kind: phenotype.** NER, adherence, and OMOP structured-data
  access were removed. Only clinical notes are read.
- **One pre-authored task: `lung-cancer-phenotype-light`.** Two categorical
  fields per patient:
  - `cancer_type`: `squamous_cell_carcinoma | adenocarcinoma | lymphoma |
    sarcoma | melanoma | neuroendocrine_tumor | no_info`
  - `disease_extent`: `local_recurrent | local_recurrent_and_metastatic |
    metastatic | no_info`
- **One agent provider: `deepagents`.** A TypeScript `DeepAgentsProvider`
  (`packages/agent-provider-deepagents`) spawns a Python sidecar
  (`python/chart_review_deepagents`) which loads the MCP tools from the
  stdio MCP server via `langchain-mcp-adapters` — one persistent session
  per patient run — and drives the agent with Azure OpenAI or vLLM.
- **Three phases: TRY → VALIDATE → DECIDE.** AUTHOR, JUDGE, LOCK, and
  DEPLOY phases were removed.
- **DECIDE** shows a per-field agent-vs-human accuracy report from
  `GET /api/performance/:taskId`.
- **Faithfulness gate** is retained. Every `set_field_assessment` call
  requires verbatim note text at verifiable byte offsets; the MCP write
  path rejects writes whose evidence quotes don't match note bytes.

---

## Quick start

### 1. Install Node dependencies

```sh
cd chart-review-platform-light
npm install
```

### 2. Set up the Python sidecar

Requires Python 3.11+. Using [uv](https://github.com/astral-sh/uv):

```sh
cd python
uv venv .venv --python 3.11
uv pip install -e .
cd ..
```

### 3. Configure environment

```sh
cp .env.example .env
# Then edit .env
```

Minimum required variables for Azure OpenAI:

```
AGENT_PROVIDER=deepagents
MCP_TRANSPORT=subprocess
DEEPAGENTS_PYTHON=/abs/path/to/python/.venv/bin/python
DEEPAGENTS_LLM_BACKEND=azure
AZURE_OPENAI_API_KEY=<your key>
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_API_VERSION=2024-06-01
AZURE_OPENAI_DEPLOYMENT=gpt-4o
CHART_REVIEW_PLATFORM_ROOT=/abs/path/to/chart-review-platform-light
```

### 4. Start the dev server

```sh
npm run dev    # Express on :3002, Vite on :5174
```

Open `http://localhost:5174`, sign in with any reviewer ID, and select
the `lung-cancer-phenotype-light` task.

---

## Workflow

```
TRY  →  VALIDATE  →  DECIDE
```

| Phase | What happens |
|---|---|
| **TRY** | Start a session, pick patients, launch an agent run. The deepagents Python sidecar reads the patient's notes via MCP tools and commits two field assessments (`cancer_type`, `disease_extent`) with evidence. Watch the agent log in real time. |
| **VALIDATE** | Human reviewer accepts or overrides each agent answer per patient. Validation saves to `var/reviews/<pid>/<task>/review_state.json`. |
| **DECIDE** | Per-field accuracy report comparing agent answers to reviewer-validated answers (`GET /api/performance/:taskId`). |

---

## Architecture

```
┌────────────┬───────────────────────────────────────────────────┐
│ React UI   │ Express + WebSocket server (TypeScript)           │
│ Studio +   │ ├─ TRY / VALIDATE / DECIDE routes                 │
│ Workspace  │ ├─ packages/mcp-server-stdio  ← MCP over stdio    │
│ panes      │ └─ packages/agent-provider-deepagents             │
└────────────┴──────────────┬────────────────────────────────────┘
                             │ spawns subprocess
                    python/chart_review_deepagents
                      ├─ langchain-mcp-adapters (1 session / run)
                      ├─ Azure OpenAI or vLLM model
                      └─ emits AgentEvents on stdout (JSONL)
```

Key seams:

- **Filesystem-as-state**: `var/reviews/`, `var/runs/`. All reads/writes go
  through `packages/storage` (`atomicWriteJson`, `readJsonOrNull`).
- **Faithfulness gate**: enforced in `packages/mcp-server-stdio`. Every
  `set_field_assessment` call verifies that the `evidence` text appears
  verbatim in the note file at the stated byte offset before writing.
- **Phase config**: `phases.ts` + `phases.ts` on the client. The three
  enabled phases are `try | validate | decide`; the task's `meta.yaml`
  also lists them explicitly.

---

## Repo layout

```
chart-review-platform-light/
├── .agents/skills/chart-review-lung-cancer-phenotype-light/
│   ├── SKILL.md          ← agent procedure
│   ├── meta.yaml         ← task_kind, phases, field definitions
│   └── references/criteria/{cancer_type,disease_extent}.md
├── client/               ← React + Tailwind + Radix Studio UI
├── server/               ← Express + WebSocket server
├── packages/
│   ├── agent-provider-deepagents/  ← TS DeepAgentsProvider
│   ├── mcp-server-stdio/           ← stdio MCP server (faithfulness gate)
│   ├── storage/                    ← atomic filesystem I/O
│   ├── domain-review/              ← review_state business logic
│   └── …
├── python/
│   ├── chart_review_deepagents/    ← Python sidecar
│   └── pyproject.toml              ← requires Python ≥3.11
├── corpus/               ← patient notes (patients/<pid>/notes/)
├── var/                  ← runtime state (gitignored)
│   └── reviews/, runs/
└── .env.example          ← all env vars documented
```

---

## Adding patients

Drop a directory under `corpus/patients/<pid>/notes/` with plain-text or
PDF note files. Add an entry to `corpus/index.json`. The patient will
appear in the session cohort picker automatically.

---

## Workflow conventions

- Feature branches (`feat/...`, `fix/...`, `refactor/...`)
- Conventional commits (`<type>(<scope>): <summary>`)
- No `--no-verify`, no secrets in commits (`.env` is gitignored)
- No push — this repo is local-only

---

## License

Private / unlicensed pending decision. Do not redistribute patient notes
or reviewer-validated `review_state.json` files outside the team.
