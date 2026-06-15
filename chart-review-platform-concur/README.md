# chart-review-platform-concur

A trimmed fork of chart-review-platform-v2. It began as the minimum viable
stack for a single phenotype chart-review task driven by an open-weights or
Azure OpenAI model via the [deepagents](https://github.com/langchain-ai/deepagents)
agent framework, and has since been extended back up toward v2: **three task
kinds** (phenotype, NER, adherence) and an **automatic rubric self-refinement
loop** that improves the rubric from the reviewer's own annotations.

---

## What it is

- **Three task kinds.** Clinical notes only (OMOP structured-data access
  stays removed):
  - **phenotype** — per-criterion categorical answers (e.g. `cancer-diagnosis`).
  - **NER** — entity-span extraction against an ontology (e.g. `bso-ad-ner`).
  - **adherence** — guideline-concordance: per-question answers plus
    deterministic rule verdicts (e.g. `asthma-adherence`). See
    [Adherence](#adherence-task) below.
- **One pre-authored phenotype task: `cancer-diagnosis`.** Two categorical
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
- **Phases: AUTHOR · TRY · JUDGE (optional) · VALIDATE · PERFORMANCE.**
  AUTHOR (rubric editor) and JUDGE (disagreement triage) were added back;
  LOCK and DEPLOY remain deferred.
- **PERFORMANCE** scores the agents against the reviewer's validated
  answers, per task kind: phenotype = per-field accuracy
  (`GET /api/performance/:taskId`), NER = per-entity-type precision/recall/F1
  (`/api/calibrate-ner`), adherence = per-question / per-rule Cohen's κ
  (`/api/pilots/:taskId/:iterId/adherence-iaa`).
- **Rubric self-refinement** (phenotype + adherence; NER attribution+propose
  only so far). From the reviewer's validated annotations the platform does
  an LLM **error analysis** on each model-vs-human mismatch (rubric gap /
  genuine ambiguity / model slip), proposes a **generalizable rule** to add to
  the rubric, validates it on a **held-out** split (Δ agreement, n_fixed /
  n_regressed), and surfaces a transparent card the reviewer **applies** — a
  versioned, **revertable** edit with the wrong-cases + proof recorded as
  provenance. Never auto-applies; never refines for a model slip. See
  `docs/superpowers/plans/2026-06-13-refine-from-human-annotations.md`.
- **Faithfulness gate** is retained. Every `set_field_assessment` call
  requires verbatim note text at verifiable byte offsets; the MCP write
  path rejects writes whose evidence quotes don't match note bytes.

---

## Adherence task

The **adherence** task kind reviews **guideline concordance** — did the care
documented in the chart follow a clinical guideline? Example task:
`asthma-adherence` (16 questions across 3 tiers).

**Two kinds of unit, and only one is LLM-driven:**

- **Questions** (`references/questions/T<tier>_*.yaml`) — the agent answers each
  (`question_id`, `answer`, evidence, confidence). A question carries its
  `text`, an `answer_schema`, and free-form `retrieval_hints` (where/how to find
  the answer). These are what the reviewer adjudicates and what refinement edits.
- **Rule verdicts** (`references/rules/*.yaml`) — `CONCORDANT` /
  `NON_CONCORDANT` / `EXCLUDED`, computed **deterministically** by the rule
  engine from the question answers (a boolean DSL over `question_id`s). They are
  *not* LLM output and are *not* refinable — to change a verdict you change the
  questions feeding it.

**Review state** (per patient): `question_answers[]` + `rule_verdicts[]`
(union of agent + reviewer; reviewer entries are `source: "reviewer"`),
`validated_questions[]`, `validated_rules[]`. A patient flips to
`reviewer_validated` when every question/rule unit is reviewer-decided
(`deriveAdherenceReviewStatus`).

**Across the phases:**

- **AUTHOR** — an *editable* question rubric: the methodologist edits each
  question's `text` and `retrieval_hints` directly
  (`AdherenceRubricPanel` → `PUT /api/tasks/:taskId/adherence-questions/:questionId`).
- **PERFORMANCE** — per-agent leaderboard: per-question / per-rule match rate +
  Cohen's κ vs the reviewer (`computeAdherenceIaa`).
- **Self-refinement** (PERFORMANCE → "Refine question guidance") — for each
  question where the agent disagreed with the reviewer's validated answer, an
  LLM error-analysis attributes it (rubric gap / ambiguity / model slip), then
  proposes a generalizable addition to that question's `retrieval_hints`,
  validates it on a held-out split, and the reviewer applies it (logged +
  revertable). The human-edit path (AUTHOR) and the agent-proposed path
  (PERFORMANCE) write the **same** tier-YAML questions.

Implementation: `packages/pipeline-extract-adherence` (skill loader),
`packages/rule-engine` (deterministic verdicts), `server/adherence-routes.ts`
(reviewer validation), `server/adherence-iaa-routes.ts` (performance),
`server/adherence-rubric-routes.ts` (AUTHOR edits), and
`server/lib/refine/adherence-*.ts` (the self-refinement loop).

---

## Quick start

### 1. Install Node dependencies

```sh
cd chart-review-platform-concur
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
CHART_REVIEW_PLATFORM_ROOT=/abs/path/to/chart-review-platform-concur
```

### 4. Start the dev server

```sh
npm run dev    # Express on :3002, Vite on :5174
```

Open `http://localhost:5174`, sign in with any reviewer ID, and select
the `cancer-diagnosis` task.

---

## Workflow

```
TRY  →  VALIDATE  →  DECIDE
```

| Phase | What happens |
|---|---|
| **TRY** | Start a session, pick patients, launch an agent run. The deepagents Python sidecar reads the patient's notes via MCP tools and commits the leaf field assessments (`cancer_type`, `has_distant_metastasis`, `has_local_recurrence`) with evidence; `disease_extent` is then computed from the two `has_*` fields. Watch the agent log in real time. |
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
chart-review-platform-concur/
├── .agents/skills/chart-review-cancer-diagnosis/
│   ├── SKILL.md          ← agent procedure
│   ├── meta.yaml         ← task_kind, phases, field definitions
│   └── references/criteria/{cancer_type,has_distant_metastasis,has_local_recurrence,disease_extent}.md
│       (disease_extent is derived: computed from the two has_* leaves)
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

## Deploy on a larger cohort

After validating a session and exporting its package (PERFORMANCE →
"Export task package"), run the validated agent on a new cohort headlessly —
no UI:

```sh
npm run deploy -- \
  --package var/exports/<task>/<exportId> \
  --data-dir /path/to/cohort \   # laid out as <patient_id>/notes/*.txt
  --out /path/to/results \
  [--agent agent_2]              # default: best agent by avg_accuracy
```

It runs a single agent (the best-performing one from the package's
`performance.json`, or `--agent`) on every patient in `--data-dir`, reusing the
same prompt, deepagents sidecar, and faithfulness gate as the UI. Outputs:

- `<out>/<patient_id>.json` — the agent's answers + cited evidence (offsets),
- `<out>/results.csv` — one row per patient, one column per field,
- `<out>/run_manifest.json` — chosen agent + reason, model, and ok/failed counts.

v1 runs on this platform (the task/skill must be installed) and uses the
`.env`-configured model — it warns if that differs from the model the package
was validated on.

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
