# chart-review-platform

Agentic chart-review platform — a methodologist drafts a rubric, two LLM
agents review each patient's chart, a human reviewer adjudicates
disagreements, the rubric iterates until inter-rater agreement
stabilizes, and the version locks at a git SHA for citation.

The platform supports **three task kinds**, all sharing the same
authoring → run → validate → lock workflow:

| Kind | What it produces per patient | Example |
|---|---|---|
| **phenotype** | One `FieldAssessment` per criterion (`confirmed`/`probable`/`absent` + evidence) | Lung-cancer phenotype, CHA₂DS₂-VASc |
| **ner** | A list of `SpanLabel`s mapped to an ontology (BSO-AD, AD-CDE) | Span extraction against an ontology |
| **adherence** | One `QuestionAnswer` per question + derived `RuleVerdict`s | Asthma adherence (NAEPP-based), statin adherence |

Lineage: this is v2 of the platform, vendored out of an
IU-Agentic-Framework monorepo. Architecture mirrors the
*Agentic Clinical Chart Review (ACCR) Framework: System Design*
(March 2026) — tier-stratified question framework, dual-track
concordance (deterministic rules + LLM-as-judge), capability subagents,
and a unified data abstraction over notes + OMOP structured data.

---

## The workflow

Every task moves through the same seven phases. The Studio UI surfaces
them as a pill bar; each phase has a dedicated pane.

```
AUTHOR ── TRY ── [JUDGE] ── VALIDATE ── DECIDE ── LOCK ── DEPLOY
   ↑                                       │
   └───────────── iterate ─────────────────┘
```

| Phase | What happens | Output |
|---|---|---|
| **AUTHOR** | Methodologist edits the rubric (criteria for phenotype, entity-type guidance for NER, questions + rules for adherence) | Skill bundle on disk |
| **TRY** | N agents run on M patients in parallel; produces per-agent drafts | `runs/<run_id>/per_patient/<pid>/agents/<agent>.json` |
| **JUDGE** (optional) | A stronger model pre-screens disagreement cells, suggests pre-fills | `judge_analyses.json` |
| **VALIDATE** | Human reviewer accepts/overrides agent answers per (patient × criterion) | `reviews/<pid>/<task>/review_state.json` |
| **DECIDE** | Per-agent leaderboard + clustered improvement proposals; one-click re-run on same cohort | Improvement proposal YAMLs |
| **LOCK** | Calibration + reproducibility bundle + locked SHA | `var/exports/<task>/<bundle_id>/` |
| **DEPLOY** | Run the locked task on a folder of new patient notes | New `runs/` outputs |

Phases can be enabled/disabled per task via `meta.yaml`.

---

## Quick start

```sh
git clone git@github.com:yuhangjiang22/chart-review-platform.git
cd chart-review-platform
npm install

cp .env.example .env
# Edit .env: set CHART_REVIEW_PLATFORM_ROOT to absolute path of this clone
# Fill in API keys (ANTHROPIC_API_KEY or AZURE_OPENAI_API_KEY)

npm run dev    # server on :3002, client on :5174
```

Open `http://localhost:5174` and sign in with any reviewer ID. The
tabbed task list shows the three kinds; pick a task to enter its
workspace.

To smoke-test an end-to-end run on the demo asthma patient:

```sh
# In the UI:
#   #/studio/asthma-adherence/try → select patient_demo_asthma_01 → Start run
# Watch the agent log; ~2 minutes per patient on haiku-4.5.
```

---

## Architecture

```
                     SKILLS (.agents/skills/<name>/)
                     ↑ loaded by task_kind discriminator
┌────────────┬───────────────────────────────────────────────────┐
│ React UI   │ Server (Node + TypeScript)                        │
│ Studio +   │ ├─ Routes per phase (TRY / JUDGE / VALIDATE / …)  │
│ Workspace  │ ├─ MCP servers (one per task_kind, anthropic +    │
│ panes      │ │  stdio transports)                              │
│            │ ├─ Agent providers (Claude SDK / Codex CLI)       │
│            │ └─ Pipelines (extract-phenotype / -ner /          │
│            │                -adherence)                        │
└────────────┴───────────────────────────────────────────────────┘
        ↕ HTTP / WebSocket          ↕ filesystem-as-state
                              (review_state.json, runs/,
                               proposals/, judge_analyses.json,
                               cohorts/, exports/)
```

Key abstractions:

- **`task_kind` discriminator** (`phenotype` | `ner` | `adherence`) on
  every task's `meta.yaml`. The runtime routes to the matching MCP
  server + pipeline + UI pane based on this single field.

- **Agent provider abstraction** (`AGENT_PROVIDER=claude|codex`). Same
  `runAgent()` call site, different backend. Claude uses an in-process
  MCP server; Codex spawns the CLI as a subprocess with a project-local
  `.codex/config.toml`.

- **Unified data abstraction** — notes + OMOP rows accessed via the same
  MCP tool set (`list_notes`, `read_notes`, `search_notes`,
  `list_structured_data`, `read_structured_data`). Backends behind this
  interface can be flat-file (today), FHIR, OMOP CDM, Epic Clarity, etc.

- **Dual-track concordance** — every adherence/phenotype rule fires a
  deterministic engine first; rules marked `nuanced: true` then get
  an LLM-as-judge pass that can reason over attribution. Both produce
  the same verdict + attribution schema.

- **Verifier post-pass** (adherence-only today) — for every
  `set_question_answer`, deterministically cross-checks against OMOP
  rows and stamps `verifier_status: confirmed|contradicted|no_check`
  on the answer. Surfaces `OMOP ✗` chips in the reviewer UI on
  contradictions.

---

## Repo layout

```
chart-review-platform/
├── .env.example              ← document required env vars
├── .agents/skills/           ← task definitions (phenotype/NER/adherence)
│   └── chart-review-asthma-adherence/  ← reference adherence task
│       ├── SKILL.md          ← agent procedure (retrieval order, etc.)
│       ├── meta.yaml         ← task_kind, enabled phases, version
│       └── references/
│           ├── questions/T{0,1,2}_*.yaml
│           ├── rules/*.yaml
│           └── attribution.yaml
├── .codex/config.toml        ← Codex CLI routing (Azure / OpenRouter / vLLM)
├── client/                   ← React + Tailwind + Radix Studio UI
├── server/                   ← Node HTTP + WebSocket + MCP servers
├── packages/                 ← ~50 typed packages (npm workspace)
│   ├── agent-provider*/      ← Claude SDK + Codex CLI providers
│   ├── mcp-core*/            ← MCP tool handlers per task_kind
│   ├── mcp-server-*-anthropic/  ← in-process MCP for Claude
│   ├── mcp-server-*-stdio/   ← JSON-RPC MCP for Codex
│   ├── pipeline-extract-*/   ← per-kind extractor + verifier
│   ├── domain-{review,iter,proposal,…}/  ← business logic
│   ├── infra-batch-run/      ← run-N-patients orchestration
│   ├── eval-{kappa,adherence-iaa,span-iaa}/  ← IAA metrics
│   ├── platform-types/       ← shared TypeScript shapes
│   └── …
├── corpus/                   ← patients
│   ├── index.json
│   └── patients/<pid>/{meta.json, notes/, omop/}
├── var/                      ← runtime state (gitignored)
│   ├── runs/, reviews/, proposals/, exports/, cohorts/
├── examples/
├── shared/
└── modules/
```

The skill bundle layout is the single key thing to know — adding a new
task = creating a new `.agents/skills/chart-review-<name>/` directory.

---

## Task kinds

### Phenotype (lung-cancer-phenotype, cha2ds2-vasc, …)

Per-criterion adjudication. Reviewer marks each `(patient × criterion)`
cell as `confirmed`/`probable`/`absent`. Inter-rater κ drives the lock
decision. Original kind — most mature, has cohort manager + deployment-κ
validation + Methods drafter.

### NER (bso-ad-ner, ad-cde-ner)

Span extraction against an ontology. Two-pass agent (find spans → map
each span to a concept via list of ontology concepts). Reviewer
validates spans note-by-note. Per-entity-type F1 + tuple κ drives the
lock decision.

### Adherence (asthma-adherence)

Question-and-rule chart review. Built from the ACCR design PDF:
tier-stratified questions (T0 eligibility → T1 control assessment →
T2 management), rule engine + LLM-judge dual-track, 9-category
attribution taxonomy. Now includes:

- **OMOP read tools** — `list_structured_data` + `read_structured_data`
  give the agent access to conditions/drugs/measurements/observations/
  procedures/encounters tables alongside notes.
- **`search_notes` MCP tool** — keyword search across all patient notes,
  returns filename + offset + ±120-char snippet per hit.
- **Verifier post-pass** — every agent answer is deterministically
  cross-checked against the matching OMOP table. Contradictions surface
  in the reviewer UI as red `OMOP ✗` chips and in the agent's next tool
  response as `OMOP CONTRADICTS YOUR ANSWER` warnings.
- **Composite summary** — cohort-level concordance rate with 95% Wilson
  CI, attribution histogram, per-patient roster.
- **Per-agent IAA leaderboard** on DECIDE — match rate + κ against
  reviewer-validated answers, per agent.
- **DEPLOY folder-pick** — `POST /api/deploy/:taskId/run` symlinks a
  server-side folder of patient notes into the corpus and starts a
  batch run against the locked rubric.

Demo patient `patient_demo_asthma_01` ships with realistic OMOP fixtures
(3 conditions, 3 drugs including a controller + SABA + OCS burst, 8
measurements including 3 ACT scores + spirometry, 5 encounters
including 1 ED visit, 1 spirometry procedure, 4 observations).

---

## Configuration

All configuration is via env vars (`.env`) and `.codex/config.toml`.
There's a read-only diagnostics page (🔧 wrench → API providers in the
Studio) that shows what's currently active without exposing secrets.

| Variable | Purpose |
|---|---|
| `CHART_REVIEW_PLATFORM_ROOT` | Absolute path of this checkout (required) |
| `AGENT_PROVIDER` | `claude` (default) or `codex` |
| `CHART_REVIEW_MODEL` | Default model for the active provider |
| `CHART_REVIEW_JUDGE_MODEL` | Optional override for the LLM-as-judge |
| `CHART_REVIEW_JUDGE_PROVIDER` | Pin the judge to one provider regardless of run provider |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | Claude provider auth |
| `ANTHROPIC_BASE_URL` | Optional — point at OpenRouter / Bedrock / proxy |
| `AZURE_OPENAI_API_KEY` | Codex provider auth when `.codex/config.toml` routes to Azure |
| `REVIEWER_AUTH` | `optional` (dev) or `required` (production) |
| `REVIEWERS` / `METHODOLOGISTS` | Comma-separated allowlists |

See [`.env.example`](.env.example) for the full list.

For Codex routing (Azure / OpenAI direct / vLLM / OpenRouter), edit
[`.codex/config.toml`](.codex/config.toml). An [example vLLM
config](.codex/config.toml.vllm) is included with comments on the
MCP-tool-survival risk on chat-completions endpoints.

---

## How it ships

This is a research platform. Every chart-review session logs structured
reasoning traces (tool calls, evidence retrieved, intermediate
reasoning, final answers, confidence scores) at
`var/runs/<run>/per_patient/<pid>/{audit.jsonl,agents/<id>_transcript.jsonl}`.
That trace stream is the substrate for the design's training-data
flywheel — frontier model → traces → preference judgments → fine-tuned
smaller models (deferred; not implemented yet).

Locked tasks can be exported as a single `.tar.gz` reproducibility
bundle containing the skill, every reviewer-validated `review_state`,
every agent batch run, per-field κ statistics, the Methods draft, and
post-lock deployment-validation cohorts.

---

## Status / what's mature

- ✅ Phenotype task kind — full lifecycle (AUTHOR → DEPLOY), N tasks shipping
- ✅ NER task kind — full lifecycle, 2 ontologies (BSO-AD, AD-CDE)
- ✅ Adherence task kind — full lifecycle for `asthma-adherence`, OMOP read tools, verifier, composite summary, folder-pick deploy
- ✅ Agent provider abstraction (Claude SDK + Codex CLI)
- ✅ Unified data abstraction (notes + OMOP) with task-kind-aware MCP tools
- ✅ Dual-track concordance (deterministic + LLM judge)
- ✅ Per-task phase enablement (`meta.yaml.phases`)
- ✅ Reproducibility bundle export

Less mature / known gaps:

- ⚠ Guideline ingestion mode (auto-generate questions from a guideline PDF) — manual authoring only
- ⚠ Capability subagents (Retriever / Extractor / Verifier as separate spawnable agents) — currently one monolithic agent per patient
- ⚠ Confidence calibration (Platt scaling) — raw model confidence, no calibration pass
- ⚠ Training pipeline (distillation / RLAIF / RLHF) — traces captured, no training loop yet
- ⚠ Multi-site adapters (FHIR / Epic Clarity / OMOP CDM proper) — only flat-file backend today

---

## Workflow conventions

- Feature branches (`feat/...`, `fix/...`, `refactor/...`, `docs/...`)
- Conventional commits (`<type>(<scope>): <summary>`)
- Don't skip hooks (`--no-verify` is off)
- Don't commit secrets — `.env` is gitignored; check in `.env.example` if you add a new variable

---

## License

Private / unlicensed pending decision. Do not redistribute notes,
OMOP fixtures, or reviewer-validated `review_state.json` files outside
the team.
