# Modularization plan — wire `packages/pipeline-*` into the hot path

**Date:** 2026-05-12
**Status:** Proposal; not yet executed.
**Predecessor specs:**
- `ORGANIZATION.md` — 76-package workspace shape (org-1.0.0). Established the package boundary.
- The workflow-phase modularization (8126a61) — phases are now a registry of swappable packages.

This doc lays out how to make `chart-review-platform-v2/packages/pipeline-*` (and `packages/workflow-*`) actually drive what happens when the user clicks TRY / JUDGE / etc., and how to drop in a *new* pipeline module without editing core.

---

## Current state

`packages/pipeline-{clarify,form-gen,discover,extract,validate,correct-log}` exist and conform to a contract from `@chart-review/v2-shared`. They're reachable via REST (`POST /api/v2/clarify`, `/api/v2/extract`, …) and via `npm run smoke`.

**But the UI doesn't use them.** When you click TRY in the Studio, the request path is:

```
UI ──► POST /api/pilots/:taskId       (not /api/v2/extract)
        ├─ startPilotIteration()      (@chart-review/domain-iter)
        ├─ startBatchRun()            (@chart-review/infra-batch-run)
        └─ for each patient:
             runAgent()                (@chart-review/agent-provider)
             MCP set_field_assessment  (@chart-review/mcp-core)
             → review_state.json
```

The pipeline modules sit as a parallel surface. Adding a new step (e.g. "PII-redact before extract", "OMOP pre-screen", "cite-verify after extract") requires editing `runs.ts` and `domain-iter` — both core packages.

**Two issues:**

1. *The pipeline modules don't compose anything actually in use.*
2. *Phases don't know about modules.* The workflow-phase packages we just added (org-12, 8126a61) declare *metadata only* — not what they do at runtime.

---

## Target — phases drive modules

Each phase declares its **pipeline composition**: an ordered list of pipeline modules to invoke, plus per-module config. A phase driver in the server resolves the list and runs the modules.

```
UI ──► POST /api/phases/try/run           (new unified endpoint)
        ├─ resolvePhasesForTask + getPhase("try")
        ├─ phase.pipeline.modules = ["discover", "extract"]
        ├─ for each module id:
        │   resolve @chart-review/pipeline-<id>
        │   run module(input)
        │   thread output → next module
        └─ return { job_id }      client polls /api/jobs/:job_id
```

### Phase ↔ module mapping (initial)

| Phase | Pipeline composition | Notes |
|---|---|---|
| AUTHOR | (none) | Rubric drafting; doesn't run pipeline |
| TRY | `form-gen → discover → extract` | The N-agent batch run. `extract` may be N>1 (dual-agent). |
| JUDGE | `validate.judge` | LLM-as-judge subset of validate |
| VALIDATE | `validate.reconcile + reviewer-UI` | Interactive — driver yields control to reviewer |
| DECIDE | (rule-proposal pipeline; separate flow) | Doesn't fit the linear module chain |
| LOCK | `correct-log + lock-task` | Finalizes audit + freezes SHA |
| DEPLOY | full pipeline on production cohort | Same as TRY but against deployment cohort |

### Pipeline modules — initial set (the existing six)

| Module | Input | Output | Where currently lives |
|---|---|---|---|
| `clarify` | NL prompt | `TaskSpec` | `@chart-review/pipeline-clarify` |
| `form-gen` | `TaskSpec` | `FormSpec` | `@chart-review/pipeline-form-gen` |
| `discover` | `Subject` + `TaskSpec` | `EvidenceUnit[]` | `@chart-review/pipeline-discover` |
| `extract` | `FormSpec` + `Subject` + `EvidenceUnit[]` + `extractor_id` | `ExtractorOutput` | `@chart-review/pipeline-extract` |
| `validate` | `ExtractorOutput[]` | `ReconciledDraft` | `@chart-review/pipeline-validate` |
| `correct-log` | `task_id` + `subject_id` + `field_id` + `HumanDecision` | `FinalizedAssessment` | `@chart-review/pipeline-correct-log` |

### Future modules — what dropping in a new one looks like

| Hypothetical | Goal | Where it slots |
|---|---|---|
| `pii-redact` | Strip PHI before sending to LLM | Between `discover` and `extract` |
| `omop-prescreen` | Use structured data to skip patients who definitely lack the phenotype | Before `extract`; short-circuits when answer is determinable from codes |
| `cite-verify` | Cross-check every cited offset before commit | Between `extract` and `validate` |
| `qa-pass` | Run a checker LLM over the extracted answers | After `extract` |
| `bias-audit` | Compare per-stratum answer distributions; flag drift | After `validate` |
| `re-extract-on-flag` | If `qa-pass` flags, re-run extract with skeptical interpretation | Conditional branch after `qa-pass` |

**The point:** all of these are *new packages* (`@chart-review/pipeline-pii-redact`, etc.). No edit to core.

---

## Target file shape

```
packages/
├── pipeline-modules/                    ← new: contract + registry
│   └── src/index.ts                       PipelineModule, registerModule, getModule, allModules
├── pipeline-clarify/                    (existing — gets a registerModule(...) at load)
├── pipeline-form-gen/                   (existing)
├── pipeline-discover/                   (existing)
├── pipeline-extract/                    (existing)
├── pipeline-validate/                   (existing)
├── pipeline-correct-log/                (existing)
├── pipeline-pii-redact/                 ← new modules drop in here
├── pipeline-omop-prescreen/
└── …

workflow-phase-{try,judge,validate,…}/  ← gain a .pipeline field
└── src/index.ts
   export const PHASE_TRY: PhaseModule = {
     ...metadata...,
     pipeline: { steps: ["form-gen", "discover", "extract"] },
   };

packages/phase-runner/                    ← new: server-side driver
└── src/index.ts                            runPhase(taskId, phaseId, input) →
                                            resolves modules → executes → emits AgentEvent stream

server/
└── phase-runner-routes.ts                 ← new: POST /api/phases/:phase/run
                                              GET  /api/phases/:phase/status/:jobId
```

---

## Module contract (`@chart-review/pipeline-modules`)

```ts
export interface PipelineModule<I = unknown, O = unknown> {
  /** Stable id used in registry + phase composition. */
  id: string;
  /** Human label for logs / UI. */
  label: string;
  /** One-sentence description shown in the methodologist's module picker. */
  description: string;
  /** Input contract — Zod schema preferred. The phase runner validates
   *  before calling. */
  inputSchema: z.ZodType<I>;
  /** Output contract. The phase runner threads this to the next module. */
  outputSchema: z.ZodType<O>;
  /** Modules this one's output naturally feeds into. Documentation only;
   *  the phase runner uses the phase's explicit chain. */
  feedsInto?: string[];
  /** Side effects this module performs — audit JSONL writes, MCP calls,
   *  file writes. Used by the dry-run mode + the audit dashboard. */
  sideEffects: ("audit" | "review-state" | "spawn-subprocess" | "llm")[];
  /** Run the module. Returns an async iterable of events so the driver
   *  can stream progress to the WS broadcaster. */
  run(input: I, ctx: PipelineCtx): AsyncIterable<PipelineEvent<O>>;
}

export interface PipelineCtx {
  taskId: string;
  subject: SubjectRef;
  reviewerId: string;
  runId: string;
  /** Audit append, MCP write, etc. — injected so modules don't reach
   *  for them directly. */
  audit: AuditAppendFn;
  reviewsRoot: string;
  /** Module-specific config from the phase's .pipeline.config[id]. */
  config: unknown;
}

export type PipelineEvent<O> =
  | { type: "started"; module_id: string }
  | { type: "progress"; module_id: string; percent: number; note?: string }
  | { type: "output"; module_id: string; output: O }
  | { type: "error"; module_id: string; error: string };

const REGISTRY = new Map<string, PipelineModule>();
export function registerModule(m: PipelineModule): void { REGISTRY.set(m.id, m); }
export function getModule(id: string): PipelineModule { … }
export function allModules(): PipelineModule[] { … }
```

Per-module registration is the same pattern as phases:

```ts
// packages/pipeline-discover/src/index.ts
import { registerModule } from "@chart-review/pipeline-modules";
export const DISCOVER_MODULE: PipelineModule<...> = { id: "discover", run: ..., ... };
registerModule(DISCOVER_MODULE);
```

A barrel file in the server boot imports each `pipeline-*` so registration happens.

---

## Phase composition

`PhaseModule` (in `@chart-review/workflow-phases`) gains an optional `pipeline` field:

```ts
export interface PhaseModule {
  id: PhaseId;
  label: string;
  // ... existing fields ...

  /** Pipeline composition. When set, the default phase driver runs
   *  these modules in order on POST /api/phases/<id>/run. Phases that
   *  are interactive (AUTHOR / VALIDATE / DECIDE) leave this undefined
   *  and provide their own driver via /api/<custom>. */
  pipeline?: {
    /** Module ids in execution order. */
    steps: string[];
    /** Per-module config. Threaded into the module's PipelineCtx.config. */
    config?: Record<string, unknown>;
  };
}
```

Example:

```ts
// packages/workflow-phase-try/src/index.ts
export const PHASE_TRY: PhaseModule = {
  id: "try",
  label: "Try",
  pipeline: {
    steps: ["form-gen", "discover", "extract"],
    config: {
      extract: { agents: 2, judge: false },
    },
  },
  // ... other fields ...
};
```

---

## Per-task module override

Methodologists can already toggle phases via `meta.yaml`'s `phases:` list. Add a sibling for **per-task pipeline tweaks**:

```yaml
# .agents/skills/chart-review-<task>/meta.yaml
phases:
  - author
  - try
  - validate
  - lock
pipelines:
  try:
    steps:                          # override the phase's default chain
      - form-gen
      - omop-prescreen              # new module, slotted in
      - discover
      - extract
    config:
      extract:
        agents: 2
        judge: false
      omop-prescreen:
        confidence_threshold: 0.85
```

The phase runner reads the task's `pipelines.<phase>` first, falls back to the phase's default `pipeline.steps`.

---

## The phase runner

```
POST /api/phases/:phase/run
Body: { task_id, patient_ids, agent_specs?, ... }
Returns: { job_id }
```

Server-side:

```ts
async function runPhase(taskId: string, phaseId: PhaseId, input: PhaseRunInput): Promise<string> {
  const phase = getPhase(phaseId);
  const taskMeta = readMetaYaml(taskId);

  // 1. Resolve module chain (task override beats phase default).
  const chain = taskMeta.pipelines?.[phaseId]?.steps
              ?? phase.pipeline?.steps;
  if (!chain) throw new Error(`phase ${phaseId} has no pipeline`);

  // 2. Resolve config.
  const config = {
    ...phase.pipeline?.config,
    ...taskMeta.pipelines?.[phaseId]?.config,
  };

  // 3. Create a job + audit context.
  const jobId = makeJobId();
  const ctx = makeCtx(taskId, input, jobId);

  // 4. Stream the modules.
  void (async () => {
    let lastOutput: unknown = input.initialInput;
    for (const moduleId of chain) {
      const mod = getModule(moduleId);
      const moduleCtx = { ...ctx, config: config[moduleId] };
      for await (const ev of mod.run(lastOutput, moduleCtx)) {
        broadcastJobUpdate(jobId, ev);                // existing WS broadcaster
        if (ev.type === "output") lastOutput = ev.output;
      }
    }
    finalizeJob(jobId);
  })();

  return jobId;
}
```

The driver:
- Threads output from one module to the next (typed via Zod schemas).
- Streams every event to the WS broadcaster — clients see live progress.
- Records every module invocation in the audit log (the `sideEffects` field tells the driver which audit categories to attribute).
- On error, halts the chain and emits an error event; previously-completed module outputs stay (so a `retry` from step K is possible).

---

## Migration — incremental, like the v2 port

| Step | Move | Effect | Verification |
|---|---|---|---|
| P1 | Add `@chart-review/pipeline-modules` with contract + registry | New package; no callers yet | `npm run typecheck` |
| P2 | Make each existing `pipeline-*` package call `registerModule(...)` at import time | Registry populates at boot | `allModules().length === 6` |
| P3 | Add `pipeline` field to `PhaseModule`; populate for TRY only | Other phases unchanged | Schema + sample data |
| P4 | Add `@chart-review/phase-runner` package with `runPhase()` driver | Library only; no endpoint wired | Smoke test runs TRY phase end-to-end |
| P5 | Add `POST /api/phases/try/run` route; route through the driver | New endpoint coexists with `/api/pilots/:taskId` | Smoke; both endpoints produce equivalent outputs |
| P6 | Change UI's TRY-phase start button to call `/api/phases/try/run` instead of `/api/pilots/:taskId` | UI flows through the modules | Run a real pilot from the UI; audit shows module-by-module events |
| P7 | Populate `pipeline` for JUDGE, LOCK, DEPLOY phases | More phases on the runner | Sample task runs end-to-end |
| P8 | Add `pipelines:` field to a few `meta.yaml` files to demonstrate per-task overrides | Per-task customization works | Toggle `omop-prescreen` on a task; observe the audit log |
| P9 | Build the first *new* module — `pii-redact` or `cite-verify` — as a real test of the recipe | Validates that "adding a module" is mechanical | Smoke + audit |
| P10 | Deprecate `/api/pilots/:taskId` (POST start) in favor of `/api/phases/try/run`; leave reads intact | Reduces parallel surface | Old endpoint returns 410 Gone with link to new path |

Tag each step `mod-0.1.0` … `mod-1.0.0`. Same milestone-driven pattern as v2 + org.

---

## Adding a new module — the recipe (after this lands)

To add `@chart-review/pipeline-omop-prescreen`:

1. Create `packages/pipeline-omop-prescreen/{src/index.ts,package.json}`.
2. Implement the contract:
   ```ts
   import { registerModule } from "@chart-review/pipeline-modules";
   export const OMOP_PRESCREEN_MODULE: PipelineModule<...> = {
     id: "omop-prescreen",
     label: "OMOP pre-screen",
     description: "Skip patients whose phenotype answer is determinable from coded data alone",
     inputSchema: ...,
     outputSchema: ...,
     sideEffects: ["audit"],
     run: async function*(input, ctx) {
       yield { type: "started", module_id: "omop-prescreen" };
       // ... real work ...
       yield { type: "output", module_id: "omop-prescreen", output };
     },
   };
   registerModule(OMOP_PRESCREEN_MODULE);
   ```
3. Add the import to `server/phase-runner-routes.ts` (or the barrel) so the module registers at boot.
4. Either:
   - Add `"omop-prescreen"` to a phase's default `pipeline.steps` — affects every task that uses that phase, OR
   - Add it to specific tasks' `meta.yaml > pipelines.<phase>.steps` — opt-in per task.
5. The methodologist's settings sheet (the wrench dialog from W6) gains a "Modules" section listing modules per phase with drag-to-reorder + add/remove.

No edits to: phase packages, core domain packages, infra packages, server route table, UI router.

---

## Why this is "really in use"

- The TRY button calls `POST /api/phases/try/run` → resolves `phase-try` → resolves modules → runs them in order.
- Audit logs show one entry per module invocation, attributing what each module did.
- A new module is a new package; the recipe is mechanical.
- A new phase combining existing modules is one new phase package + one `pipeline.steps` array.
- A task that needs custom pipelines just declares them in `meta.yaml`.

The 6-module pipeline stops being a parallel surface and becomes the spine.

---

## Deferred

- **Conditional branches** in pipelines (e.g. "if `qa-pass` flagged, run `re-extract-on-flag`, else skip"). The initial driver runs a linear chain. Branch-on-output is a v2 of the driver — likely needs a small DSL or a graph representation. Defer.
- **Parallel modules within a phase** (e.g. agent_1 and agent_2 both running `extract` simultaneously). The current `extract` module already handles N-agent fan-out internally; the *driver* runs the chain linearly. If we want module-level parallelism (e.g. run `cite-verify` + `bias-audit` in parallel after `extract`), the driver gets a `{ parallel: [...] }` syntax. Defer.
- **Cross-phase module sharing** (e.g. `cite-verify` runs in both TRY and VALIDATE). Today this just means listing it in both phases' `steps`. No infrastructure change needed.
- **A module marketplace** (third parties publish modules). The package format is already npm-compatible; this is mostly a packaging + permission decision. Defer.

---

## Open questions

1. Should the `pipeline` field on `PhaseModule` be required, or stay optional (since AUTHOR / VALIDATE / DECIDE are interactive)? Recommendation: optional. Interactive phases just don't have a runnable chain.
2. Should `taskMeta.pipelines` *replace* the phase's `pipeline.steps`, or *layer on top* (insert / remove specific steps)? Replace is simpler; layering is more flexible. Recommendation: start with replace.
3. Should the methodologist's UI for editing pipelines be a real drag-and-drop graph, or a flat ordered list? Flat ordered list ships in P9; graph is a follow-up.
4. Do we version pipeline modules? E.g. `extract@2.0.0` could break the contract. Recommendation: version each package independently via `changesets`; the phase declares `extract` and gets the workspace version.
