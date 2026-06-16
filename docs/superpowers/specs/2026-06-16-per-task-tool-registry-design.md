# Per-task tool registry — design

**Date:** 2026-06-16
**Status:** draft — tool-location decision made: **Hybrid (C)**
**Forcing function:** bringing RUCAM (`../RUCAM/agent_v2`) into concur as a first-class
phenotype task with its own domain tools.

## Problem

concur decides which MCP tools a run exposes in **three scattered, ad-hoc places**:

1. **`task_kind` code-gate in the stdio server** — adherence's question tools are
   wrapped in `if (task.task_kind === "adherence")` (`mcp-server-stdio/src/index.ts`).
2. **Hard-coded per-run allowlists** — `adherenceTools` array + `phenotypeToolset()`
   in `infra-batch-run/src/runs.ts`, pinned via `CHART_REVIEW_MCP_TOOLS`.
3. **The `uses_structured_data` flag** + the `want()` allowlist gate.

This works for the three built-in kinds but has **no way for a task to bring its own
bespoke tool set**. RUCAM is the proof: it needs ~16 DILI-specific tools — data
accessors (`get_lft_series`, `get_serology`, `get_medications`) *and* domain
calculators (`get_drug_episodes` with the 45-day-gap rule, `get_lab_extremum`,
`compute_r_ratio` → injury type). Adding it the adherence way (`if task_kind ===
"rucam"`) does not scale, and the tool logic already exists as Python in
`RUCAM/agent_v2/tools.py`.

## Goals

- One **declarative** source of truth for a task's tool surface, skills, data source,
  and output mapping — a *tool profile* keyed by task.
- A task can contribute **task-specific tools** without editing the core server gates.
- **Fold in** the existing three tiers (generic, adherence-gate, `uses_structured_data`)
  with no behavior change — the registry generalizes what we already shipped.
- RUCAM fits as the first non-built-in consumer.

## Non-goals

- Re-deriving RUCAM's scoring methodology — the `rucam-scoring` skill files are
  authoritative and ported as-is into concur criteria.
- A new output contract — RUCAM maps onto concur's existing criteria + derived-field
  model (see "Output", below).
- Per-item vs per-patient invocation strategy — flagged as an extension, not core.

## Key context: how the two agents get their tools

Both run on **deepagents `create_deep_agent`**. The difference is tool provenance:

| | concur | RUCAM (`agent_v2`) |
|---|---|---|
| Tools | MCP tools, stdio TS server, loaded via `langchain-mcp-adapters` | Python functions passed directly to `create_deep_agent(tools=[...])` |
| Faithfulness | enforced at the MCP write boundary | none (research script) |
| Write path | `set_field_assessment` → `review_state.json` | `response_format=RUCAMItemResult` per invocation |
| Skills | one bundle (`SKILL.md` + criteria) | per-item skill files, one invocation per item |
| Data | per-patient OMOP JSON + notes | CSV time-series (`lft_series`, `serology`, `all_meds`, …) |

The registry has to bridge **MCP-provided tools** and **Python-provided tools**.

## Design: the Tool Profile

A new seam — `packages/task-tools` — resolves every task to a `ToolProfile`:

```ts
export interface ToolProfile {
  /** Shared MCP tools every agent of this kind gets (notes, criteria, write). */
  baseTools: string[];
  /** Adds list/read_structured_data. Folds in today's `uses_structured_data`. */
  structuredData: boolean;
  /** Extra task-specific tools REGISTERED IN THE STDIO SERVER (TS). Faithfulness
   *  + audit + the write path apply. Use for any tool that writes review_state
   *  or cites note byte-offsets. */
  mcpTools: string[];
  /** Task-specific READ/COMPUTE tools the sidecar loads as Python plugins
   *  (import paths). Use for pure read/derivation tools that cite structured
   *  rows or computed values — NOT note bytes and NOT review_state writes. */
  pythonPlugins: string[];
  /** Skill dirs/files to load (defaults to the task's own bundle). */
  skills: string[];
  /** Backing data adapter id (e.g. "omop", "rucam-csv"). */
  dataSource: string;
}

export function toolProfileFor(task: CompiledTask): ToolProfile;
```

`toolProfileFor` is resolved **once per run** and threaded to both halves:
- **stdio server**: the allowlist becomes `baseTools + (structuredData ? STRUCTURED : []) + mcpTools` — replacing the `want()`-plus-`task_kind` ad-hoc gates with one computed set.
- **sidecar (runspec)**: `pythonPlugins`, `skills`, `dataSource` ride in the run spec so the deepagents agent loads them alongside the MCP tools.

### Declaration

A task names a profile in `meta.yaml` (extending the `uses_structured_data` pattern):

```yaml
task_type: phenotype_validation
tool_profile: rucam          # names a registered profile; absent → default
uses_structured_data: true
```

`tool_profile: rucam` resolves to a registered entry that declares the rucam
`mcpTools` / `pythonPlugins` / `skills` / `dataSource`. **No `tool_profile`** → the
default profile = today's phenotype base + `uses_structured_data` behavior
(**backward compatible**).

### Folding in the existing tiers (refactor, zero behavior change)

| Today | Becomes |
|---|---|
| generic tools | `baseTools` of every profile |
| `if task_kind === "adherence"` server gate + `adherenceTools` array | an `adherence` profile (question tools as `mcpTools`) |
| `uses_structured_data` flag | `structuredData: true` in the profile |
| `phenotypeToolset()` | the default phenotype profile |

## The crux: where do task-specific tools live? (decision required)

- **A — MCP-native (port to TS).** Re-implement RUCAM's tools in the stdio server,
  selected by the profile. ONE tool path; faithfulness/audit/allowlist apply
  uniformly. Cost: port ~16 Python tools incl. domain logic (45-day gap, R-ratio)
  and keep parity with the Python reference.
- **B — sidecar Python plugins.** The sidecar loads the task's Python module
  (`RUCAM/agent_v2/tools.py` ~as-is). Reuses RUCAM verbatim. Cost: those tools
  bypass the MCP faithfulness gate, audit hooks, and storage write path; two
  provenance regimes; the TS server can't "see" them.
- **C — hybrid (recommended).** Split by responsibility, not by task:
  - **Must be MCP** (`mcpTools`): anything that *writes* `review_state`
    (`set_field_assessment`) or cites *note byte-offsets* (`find_quote_offsets`,
    note reads) — these need the faithfulness gate + audit.
  - **May be Python plugin** (`pythonPlugins`): pure *read/compute* tools whose
    "evidence" is a structured row or a derived value, not note bytes — RUCAM's
    `get_lft_series`, `get_serology`, `get_drug_episodes`, `get_lab_extremum`,
    `compute_r_ratio`. They don't write review_state and don't cite note bytes.

  **Invariant:** writes + note-faithfulness go through MCP; read/compute tools may
  be plugins. This lets RUCAM's read/compute tools be reused immediately while the
  write + note path stays uniform and gated.

  **DECISION: C (hybrid).** Concretely for RUCAM:
  - **MCP (TS, guarded):** `set_field_assessment`, `find_quote_offsets`, the note
    reads (`list_notes`/`read_note`/`search_notes`), `set_review_status` — the
    write + note-citation surface, shared with all phenotype tasks (`baseTools`).
  - **Python plugins (sidecar, read/compute):** `get_lft_series`, `get_lab_extremum`,
    `get_serology`, `get_medications`, `get_drug_episodes` (45-day-gap merge),
    `get_conditions`, `get_patient_summary`, `get_suspect_drug`,
    `get_hepatotoxicity_category`, `compute_r_ratio` — reused from
    `RUCAM/agent_v2/tools.py`, none of which write review_state or cite note bytes.

## Data source abstraction

RUCAM's tools read CSV; concur reads OMOP JSON. Tools are written against a named
`dataSource` adapter, not raw files. RUCAM-in-concur needs either (a) a `rucam-csv`
adapter exposing `lft_series`/`serology`/`all_meds`/`conditions`, or (b) mapping
RUCAM data into concur's OMOP/notes model. Sub-design; the registry only needs the
adapter *id* here.

## Output (no new contract)

RUCAM's `RUCAMItemResult` (score + `structured_evidence` + `note_evidence` +
reasoning) maps onto a concur **leaf criterion** — the score is the answer, the two
evidence strings become `source:"omop"` / `source:"note"` evidence, reasoning is the
rationale. `RUCAMScorecard.total_score` and `interpretation` are **derived fields**
(exactly the `disease_extent` derivation pattern); `injury_type`/`r_ratio` are a
computed input a tool provides. So RUCAM's 7 items + 2 derivations are 7 criteria +
2 derived fields — it already fits.

Open: tools that emit *computed* values (R-ratio) want a third evidence source —
`source:"computed"` with provenance = the input rows. concur already accepts
`source:"omop"` (the faithfulness gate skips non-note evidence); a `"computed"` source
is a small extension.

## Rollout

1. **Registry + refactor** — build `packages/task-tools`, express the three existing
   tiers as profiles, thread `toolProfileFor` through the stdio server + the runspec.
   No behavior change; existing suites stay green.
2. **RUCAM profile** — register `rucam`: read/compute tools as Python plugins (hybrid),
   a `rucam-csv` data adapter, the 7 items as criteria + 2 derived fields, the
   `rucam-scoring` skill files.
3. **Validate** — run RUCAM-in-concur against `RUCAM_chart_review_tables` (human
   scores) and the standalone `agent_v2` outputs for parity.

## Risks / open questions

- The A/B/C tool-location decision (recommend C) — gates everything downstream.
- `source:"computed"` evidence for derived tool values (R-ratio).
- Data adapter shape (CSV → concur model).
- Per-item vs per-patient invocation — RUCAM invokes once per item; concur once per
  patient. A profile-level `invocationStrategy` is a plausible extension.
- Faithfulness for plugin tools: plugins can't write review_state, so the gate's
  invariant holds, but we must *enforce* that plugins are read-only (lint/registration check).
