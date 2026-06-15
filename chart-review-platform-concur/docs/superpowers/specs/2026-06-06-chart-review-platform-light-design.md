# chart-review-platform-light — Design

**Date:** 2026-06-06
**Status:** Approved (brainstorming complete; next step = implementation plan)
**Author:** yj38 + Claude

## Summary

`chart-review-platform-light` is a **fork of `chart-review-platform-v2`**, trimmed
to a single task kind and a single agent backend. It is produced by copying v2 and
then applying a focused set of strip/swap diffs — **everything not listed below stays
byte-for-byte identical to v2**. The light platform reviews clinical notes only,
runs one phenotype task (cancer type + disease extent), drives extraction exclusively
through [deepagents](https://github.com/langchain-ai/deepagents), and supports two
LLM backends (Azure OpenAI and vLLM).

This is explicitly **not a rewrite**. The React Studio/Workspace UI, Express +
WebSocket server, filesystem-as-state, the note-reading MCP tools, the faithfulness
gate, the phenotype pipeline, and the κ/agreement math are all retained unchanged.

## Goals (the seven requirements)

1. Live in a new directory `chart-review-platform-light/` (sibling of `chart-review-platform-v2/`).
2. Keep **only the phenotype** task kind. Remove NER and adherence.
3. Tasks involve **clinical notes only**. Remove OMOP / structured-data access.
4. Ship one pre-authored task that extracts two fields per patient:
   - **`cancer_type`** ∈ { `squamous_cell_carcinoma`, `adenocarcinoma`, `lymphoma`, `sarcoma`, `melanoma`, `neuroendocrine_tumor`, `no_info` }
   - **`disease_extent`** ∈ { `local_recurrent`, `local_recurrent_and_metastatic`, `metastatic`, `no_info` }
   - (`no_info` is an explicit escape so the agent is not forced to guess when the notes do not say.)
5. Use **deepagents** as the only agent framework.
6. LLM backend is **Azure OpenAI or vLLM**. vLLM is unavailable in this environment, so Azure is used for testing.
7. Support only three pipeline steps: **agent run → human validation → performance report**. No AUTHOR / JUDGE / LOCK / DEPLOY.

## Non-goals

- No NER or adherence task kinds.
- No OMOP / FHIR / structured-data tools or verifier post-pass.
- No rubric authoring UI, judge pre-screen, lock/reproducibility bundle, or deploy-to-folder.
- No improvement-proposal clustering or one-click re-run (those serve the iterate loop we are not keeping).
- No new UI framework. The existing React UI is reused and only trimmed.

## Architecture

Same two-halves-over-the-filesystem architecture as v2:

```
              SKILLS (.agents/skills/chart-review-lung-cancer-phenotype-light/)
┌────────────┬───────────────────────────────────────────────────┐
│ React UI   │ Server (Node + TypeScript)                        │
│ Studio +   │ ├─ Routes: TRY / VALIDATE / DECIDE only           │
│ Workspace  │ ├─ stdio MCP server (notes-only)                  │
│ panes      │ ├─ Agent provider: deepagents ONLY                │
│ (3 phases) │ └─ Phenotype pipeline (unchanged)                 │
└────────────┴───────────────────────────────────────────────────┘
        ↕ HTTP / WebSocket          ↕ filesystem-as-state
                              (review_state.json, runs/)
                                       ↕ spawn
                          Python sidecar: deepagents
                          + langchain-mcp-adapters
                          + Azure/vLLM model factory
```

### What is UNTOUCHED (carried over from v2 verbatim)

- React Studio / Workspace shell and the VALIDATE pane (patient list, note viewer with
  evidence-span highlighting, per-cell accept/override, dual-agent layout).
- Express HTTP server + WebSocket transport; filesystem-as-state.
- `review_state.json` shape (`field_assessments[]` with answer / confidence / evidence /
  rationale / source / status).
- Note MCP tools: `list_notes`, `read_note`, `read_notes`, `search_notes`,
  `get_review_state`, `set_field_assessment`.
- The **faithfulness gate** inside `set_field_assessment` (whitespace-tolerant verbatim
  quote check at byte offsets).
- The phenotype extraction pipeline and the κ / percent-agreement / confusion-matrix math.
- The `storage.ts`, `model-config.ts`, `phases.ts` seams.

### What is REMOVED

- **Task kinds:** delete NER + adherence — `mcp-core-ner`, `mcp-core-adherence`,
  `mcp-server-*-ner-*`, `mcp-server-*-adherence-*`, `pipeline-extract-ner`,
  `pipeline-extract-adherence`, `eval-span-iaa`, `eval-adherence-iaa`, their UI panes
  (`SpanReview`, `AdherenceReview`, span/adherence Workspace phases), and their skill bundles.
- **OMOP / structured data:** delete the `list_structured_data` and `read_structured_data`
  tool registrations from the stdio MCP server; drop `corpus/*/omop/`; remove the verifier
  post-pass.
- **Phases:** reduce `PHASE_DEFS` to `TRY → VALIDATE → DECIDE`. Drop `AUTHOR`, `JUDGE`,
  `LOCK`, `DEPLOY`. (Phases are data-driven; this is a `PHASE_DEFS` edit plus deleting the
  now-unused phase panes.)
- **Agent providers:** remove `agent-provider-claude` and `agent-provider-codex`.
  `deepagents` becomes the sole provider.
- **DECIDE extras:** remove improvement-proposal clustering and one-click re-run; keep only
  the performance summary.

### What is ADDED

#### 1. The pre-authored task

`.agents/skills/chart-review-lung-cancer-phenotype-light/`:
- `meta.yaml` — `task_kind: phenotype`, `phases: [try, validate, decide]`, source-doc priority
  (pathology > oncology note > imaging).
- `fields/cancer_type.yaml` and `fields/disease_extent.yaml` — each an `enum` answer schema +
  extraction guidance, in the same `CompiledField`/criterion shape v2 already consumes.
- `SKILL.md` — agent procedure: read notes only, cite verbatim evidence, record one answer per
  field via `set_field_assessment`.

#### 2. `agent-provider-deepagents` (TypeScript)

A new package registered in `buildProvider`'s switch (`ProviderName` becomes just `"deepagents"`),
selected via `AGENT_PROVIDER=deepagents`. It implements the existing `AgentProvider` interface
(`run(input): AsyncIterable<AgentEvent>`) by **spawning the Python sidecar as a subprocess** —
mirroring `agent-provider-codex` exactly — parsing the sidecar's JSONL stdout into the platform's
normalized `AgentEvent` taxonomy (`tool_use`, `tool_result`, `text`, `result`, `error`), and
honouring `transcriptPath` for auditability.

#### 3. Python sidecar — `python/chart_review_deepagents/`

- `__main__.py` — receives the run spec (patient_id, task fields, persona, reviews root, the
  command to launch the stdio MCP server) via argv/env; builds a deepagents agent; runs it; streams
  JSONL events on stdout in the `AgentEvent` taxonomy.
- `models.py` — model factory keyed on `DEEPAGENTS_LLM_BACKEND=azure|vllm`:
  - `azure` → `AzureChatOpenAI` using `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`,
    `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`.
  - `vllm` → `ChatOpenAI(base_url=VLLM_BASE_URL, api_key=VLLM_API_KEY, model=VLLM_MODEL)`.
- Tools via `langchain-mcp-adapters`: the sidecar launches v2's `mcp-server-stdio` (notes-only after
  the OMOP strip) and loads its tools as LangChain tools, so the faithfulness gate, note tools, and
  the `set_field_assessment` write path are reused verbatim.
- `pyproject.toml` — `deepagents`, `langchain-openai`, `langchain-mcp-adapters`.

The exact `create_deep_agent` signature and `langchain-mcp-adapters` API are pinned against the
installed package versions during the planning step.

## Data flow

1. **Agent run (TRY).** Reviewer picks patients and **1 or 2 agents** in the existing run UI.
   `infra-batch-run` drives N patients × {1|2} agents through the same `runAgent()` call site,
   now routed to `DeepAgentsProvider`. 2-agent mode reuses v2's `default` + `skeptical` persona
   pattern. Each agent reads notes via MCP and records one answer per field via `set_field_assessment`;
   the faithfulness gate rejects fabricated quotes. Results land in `review_state.json` with
   `source: agent`. No auto-reconcile.

2. **Human validation (VALIDATE).** The reviewer works the existing VALIDATE pane: note viewer with
   highlighted evidence, per-(patient × field) cells showing each agent's answer / confidence /
   evidence, accept or override with an edit reason. In 2-agent mode disagreements are flagged for the
   human to resolve. Final answers are written with `source: human`.

3. **Performance report (DECIDE).** After validation, DECIDE shows the per-agent leaderboard:
   match-rate + Cohen's κ vs the reviewer-validated final answers, per field, plus a confusion matrix
   and per-class breakdown.

## Error handling

- **Faithfulness failures:** unchanged — `set_field_assessment` rejects a quote that does not match note
  bytes; the agent self-corrects before finishing.
- **Sidecar failures:** the provider surfaces non-zero exit / parse errors as an `AgentEvent` of type
  `error`, consistent with how the Codex provider handles CLI failures.
- **Backend/auth misconfiguration:** `models.py` fails fast with a clear message naming the missing env
  var (e.g. `AZURE_OPENAI_ENDPOINT`).
- **Missing notes / corrupt corpus:** existing v2 behaviour retained.

## Testing strategy

- Keep relevant v2 vitest suites: faithfulness, kappa, phases, storage. Delete NER/adherence tests.
- Add a Python sidecar smoke test: run one patient through Azure, assert `review_state.json` is written
  and all evidence passes the faithfulness check.
- Trim Playwright e2e to the phenotype `run → validate → decide` flow.
- Typecheck (`tsc --noEmit`) must pass after the strip — dangling imports to deleted packages are the
  main risk and the canary.

## Fork mechanics

- Create `chart-review-platform-light/` as a sibling of `chart-review-platform-v2/`, copying source but
  excluding `node_modules/`, `var/runs/`, `var/reviews/`, `.git`, and `.codex/sessions/`.
- Fresh `npm install`, then apply the strip/swap diffs above.
- New env vars documented in `.env.example`: `AGENT_PROVIDER=deepagents`, `DEEPAGENTS_LLM_BACKEND`,
  the `AZURE_OPENAI_*` set, and the `VLLM_*` set.

## Open items resolved during brainstorming

- Validation UI: reuse v2's (answer "similar to current platform").
- Agent count: user-selectable 1 or 2.
- Notes source: reuse the v2 lung corpus; gold comes from human validation.
- Evidence: verbatim quotes + faithfulness check (port retained as-is).
- Integration: Python sidecar + stdio MCP (not deepagentsjs).
- Providers: deepagents only (claude + codex removed).
