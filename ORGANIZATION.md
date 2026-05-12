# Code organization — proposal: monorepo with one package per concern

**Date:** 2026-05-11
**Status:** Proposal; not yet adopted. Drafted to compare with OpenAI's `codex` repo layout and Xuguang's IU-Agentic-Framework on the same axes.
**Author intent:** define what "good organization" looks like for this codebase *before* doing a second pass through the v2 port. Surface decisions to make.

---

## Motivation — what hurts today

The repo has accumulated several axes of variation without giving each one a real package boundary:

- **Agent provider**: Claude (via OpenRouter), Codex (via Azure). Selected by `AGENT_PROVIDER` env + per-run dropdown. Code lives in three files (`agent-provider.ts`, `agent-provider-claude.ts`, `agent-provider-codex.ts`) alongside ~100 other top-level files.
- **MCP transport**: in-process (Claude SDK) vs stdio subprocess (Codex). Code lives in three files (`mcp-handlers.ts` pure, `mcp-tools.ts` Claude adapter, `mcp-stdio-server.ts` Codex adapter) with no shared package.
- **Workflow domain**: chart review, lit extraction, future (radiology, etc.). v2 introduced `modules/{1..6}/` and `workflows/{chart-review,lit-extract}.ts` to express this. The legacy v1 code path doesn't share that structure.
- **Skill**: ~24 phenotype skills + universal `chart-review` + `chart-review-judge` + `chart-review-builder`. Loaded from `.agents/skills/<name>/` at runtime; no `package.json` per skill, no version pinning, no programmatic discovery API.
- **Server surface**: HTTP routes, WebSocket broadcaster, MCP servers, agent runners — all interleaved in `app/server/`. Single binary; no way to ship "HTTP only" or "WS only" without code edits.

Symptoms:

- Adding a new provider requires touching `agent-provider.ts` (factory), `compose-agent.ts` (options), and any caller that wants the override. There's no "drop a package, register it" path.
- Adding a new MCP tool requires touching three files (`mcp-handlers.ts`, `mcp-tools.ts`, `mcp-stdio-server.ts`) to stay in sync.
- Skills can't be shared with other agent frameworks (e.g. Xuguang's IU-Agentic-Framework) as installable units. They're hidden under a dot directory and rely on filesystem walk.
- v2 ports v1's route handlers by importing v1's domain functions across a project boundary. Those imports work because of relative paths; they'd break the moment v1 is archived.

---

## Reference — how `openai/codex` (codex-rs) splits its workspace

Codex's Rust workspace under `codex-rs/` has ~17 crates. Each crate owns one boundary:

| Crate | Owns |
|---|---|
| `model-provider/`, `model-provider-info/` | Provider abstraction + metadata |
| `chatgpt/` | One concrete provider (OpenAI/ChatGPT) |
| `codex-mcp/`, `mcp-server/`, `rmcp-client/` | MCP protocol + Codex-as-MCP-server + remote MCP client |
| `tool-api/`, `tools/` | Tool *interface* and tool *implementations* |
| `core/`, `core-api/`, `core-plugins/`, `core-skills/` | Business logic, public API, plugin extension surface, built-in skills |
| `protocol/`, `app-server-protocol/` | Wire types separated from logic |
| `cli/`, `exec/`, `tui/` | Three thin entry-point crates composing the same core |
| `apply-patch/` | One specific tool implementation as its own crate |

The invariant is clear: **adding a provider, a tool, or a skill means adding a new crate. Core code is never edited.**

This proposal applies the same invariant to our TypeScript codebase as an npm-workspace monorepo.

---

## Target structure

```
chart-review-agents/                    (repo root, npm workspaces + tsc -b)
├── packages/
│   ├── agent-core/                     provider-neutral types (AgentEvent, AgentRunInput)
│   ├── agent-provider/                 AgentProvider interface only
│   ├── agent-provider-claude/          @anthropic-ai/claude-agent-sdk + OpenRouter
│   ├── agent-provider-codex/           Codex CLI subprocess
│   ├── agent-provider-azure-direct/    (future) direct Azure Responses API
│   │
│   ├── mcp-core/                       transport-neutral handlers + McpSession
│   ├── mcp-tools-chart-review/         set_field_assessment, find_quote_offsets, …
│   ├── mcp-tools-builder/              guideline-builder tools
│   ├── mcp-server-stdio/               @modelcontextprotocol/sdk adapter
│   ├── mcp-server-anthropic/           in-process MCP via claude-agent-sdk
│   │
│   ├── skills/
│   │   ├── chart-review/               universal reviewer
│   │   ├── chart-review-judge/
│   │   ├── chart-review-builder/
│   │   └── phenotypes/
│   │       ├── lung-cancer-phenotype/
│   │       ├── has-bled/
│   │       ├── cha2ds2-vasc/
│   │       └── …
│   │
│   ├── pipeline-clarify/               v2 module — domain-agnostic clarify step
│   ├── pipeline-form-gen/
│   ├── pipeline-discover/
│   ├── pipeline-extract/
│   ├── pipeline-validate/
│   ├── pipeline-correct-log/
│   │
│   ├── domain-review/                  review_state + UiAction
│   ├── domain-iter/                    pilot iter lifecycle
│   ├── domain-proposal/                rule proposals
│   ├── domain-cohort/                  deployment cohort + κ
│   ├── domain-issue/                   deployment issues queue
│   ├── domain-bundle/                  reproducibility export
│   ├── domain-rubric/                  phenotype skill bundle loader
│   │
│   ├── infra-batch-run/                startBatchRun, run manifests
│   ├── infra-jobs/                     async job queue
│   ├── infra-audit/                    audit-trail JSONL
│   ├── infra-storage/                  atomicWriteJson, pathFor
│   │
│   ├── workflow-chart-review/          composes pipeline + skills for chart review
│   ├── workflow-lit-extract/           same shape, lit-extract domain
│   │
│   ├── server-http/                    REST route handlers
│   ├── server-ws/                      WebSocket broadcaster + chat session
│   ├── server-app/                     binary that composes server-http + server-ws
│   │
│   └── ui-studio/                      React client
│
├── lib-py/                             Python sidecar (parser, derivation, faithfulness, CLI)
├── corpus/                             synthetic patients
├── docs/
├── examples/                           smoke + integration scripts
├── scripts/                            build / dev utilities
└── package.json                        (workspaces root)
```

---

## Module × agent × skill matrix

Which pipeline module uses which agent and which skill. Read this as: when a workflow invokes module M, M dispatches through agent A and activates skills S.

| Module | Uses agent? | Skills activated |
|---|---|---|
| `pipeline-clarify` | yes (lightweight) | none — pure NL → structured task spec |
| `pipeline-form-gen` | no — deterministic | none |
| `pipeline-discover` | depends on domain | none for chart-review (filesystem walk); domain-specific for lit-extract (PubMed/bioRxiv MCP) |
| `pipeline-extract` | **yes** — the heavy one | `chart-review` (universal reviewer) + `chart-review-<taskId>-phenotype` (the task's rubric) |
| `pipeline-validate` (reconcile) | no — pure compare | none |
| `pipeline-validate` (judge, optional) | yes | `chart-review-judge` |
| `pipeline-correct-log` | no | none |

Other agent uses outside the 6-module pipeline:

| Surface | Agent? | Skills |
|---|---|---|
| Authoring (`workflow-authoring`) | yes | `chart-review-builder` |
| Methods drafter | yes | (prompt-only, no skill activation) |
| Feedback / cohort-analyze | yes | (prompt-only) |
| Guideline-improvement / codify | yes | (prompt-only) |

**Provider selection per module.** The agent runtime is chosen per-call via `AgentProvider` (Claude or Codex). Module code never names a provider; the workflow passes the provider in via config. Today:

- Default: `AGENT_PROVIDER=claude` (Claude via OpenRouter, model `anthropic/claude-haiku-4.5`)
- Per-pilot override: `provider` field on the pilot manifest (UI dropdown)
- Forced for judge: `CHART_REVIEW_JUDGE_PROVIDER=claude` env var pins judge to Claude regardless of run provider, because Codex's response format doesn't carry the `<JUDGE_ANALYSIS>` sentinel the parser expects

In the proposed structure this lives in `workflow-*` packages as wiring:

```ts
// packages/workflow-chart-review/src/index.ts
export function makeChartReviewPipeline(opts: {
  taskId: string;
  agentProvider: AgentProvider;
  judgeProvider?: AgentProvider; // optional override
}) {
  return composePipeline({
    extract: makeExtract({
      provider: opts.agentProvider,
      skills: ["chart-review", `chart-review-${opts.taskId}-phenotype`],
    }),
    judge: makeJudge({
      provider: opts.judgeProvider ?? opts.agentProvider,
      skills: ["chart-review-judge"],
    }),
    // … other modules
  });
}
```

The skill names are strings the workflow knows about. The skill loader (in O8) resolves each name to a directory under `packages/skills/`.

---

## Adding a new task (= new phenotype)

A "task" in this codebase is a phenotype (lung-cancer, HAS-BLED, CHA₂DS₂-VASc, etc.). Each task has its own rubric, criteria, edge cases, keyword sets. The pipeline modules + agent + MCP tools + workflow composition are all **shared across tasks** — only the skill differs.

Recipe to add a new task (after the reorg lands):

1. Create `packages/skills/phenotypes/<task-id>/` with:
   ```
   <task-id>/
   ├── package.json              # name: "@chart-review/skill-<task-id>", version, deps
   ├── SKILL.md                  # the skill prompt activated by the agent
   ├── meta.yaml                 # task metadata (review_unit, stratify_by, final_output, …)
   ├── references/
   │   ├── criteria/             # one .md per leaf criterion
   │   ├── code_sets/            # ICD / OMOP code lists
   │   ├── keyword_sets/         # search terms
   │   └── edge_cases/           # disambiguators
   └── README.md                 # human-facing description (optional)
   ```
2. Add the package to the workspace's `package.json` workspaces glob (auto-discovered if the glob is `packages/skills/**`).
3. (Optional) Add a corpus of synthetic patients under `corpus/patients/<patient_id>/` with ground-truth labels for this task.

That's it. No code changes to:

- `pipeline-extract` (it reads `chart-review-<taskId>-phenotype` from the skill loader)
- `agent-provider-*` (provider is task-neutral)
- `mcp-tools-chart-review` (tools are task-neutral)
- `server-http` (`/api/tasks/:taskId` auto-lists every skill matching the phenotype-skill pattern)
- `workflow-chart-review` (parameterized by `taskId`)

The UI picks up the new task on next page load because `GET /api/tasks` reads from the skill registry.

**Important constraint:** if the new task needs *new MCP tools* (not just new criteria), that's a different operation — create a sibling package `packages/mcp-tools-<task-id>/` and have the task's skill declare a dependency on it. The skill loader can refuse to activate a skill whose declared tools aren't loaded (deferred to the design of the skill schema, see Open Questions).

---

## Per-package contracts

What each package exposes to the world, and what it depends on. Direction matters — a package never imports anything "below" itself.

| Package | Depends on | Exposes |
|---|---|---|
| `agent-core` | (none) | `AgentEvent`, `AgentRunInput`, `ProviderName` |
| `agent-provider` | `agent-core` | `interface AgentProvider { run(input): AsyncIterable<AgentEvent> }` |
| `agent-provider-claude` | `agent-provider`, `@anthropic-ai/claude-agent-sdk` | `ClaudeAgentProvider` class |
| `agent-provider-codex` | `agent-provider` + spawn(codex) | `CodexAgentProvider` class |
| `mcp-core` | `domain-review`, `infra-audit` | Pure handler functions (`setFieldAssessment`, `findQuoteOffsets`, …) + `McpSession` type |
| `mcp-tools-chart-review` | `mcp-core` | Tool definition records (id, JSON schema, handler reference) |
| `mcp-server-stdio` | `mcp-tools-*`, `@modelcontextprotocol/sdk` | `makeStdioMcpServer(tools): stdin/stdout server` |
| `mcp-server-anthropic` | `mcp-tools-*`, `@anthropic-ai/claude-agent-sdk` | `makeAnthropicMcpServer(tools): SdkMcpServer` |
| `skills/<name>` | (none — pure data + prose) | `SKILL.md` + `meta.yaml` + optional `references/`; loader-readable |
| `pipeline-*` | `agent-provider`, `domain-*`, `mcp-tools-*` | One module of the 6-step pipeline |
| `workflow-chart-review` | `pipeline-*`, `skills/chart-review*` | `makeChartReviewPipeline(opts)` |
| `domain-*` | `infra-storage`, `infra-audit` | Aggregate root: types, repo functions, lifecycle helpers |
| `infra-*` | (minimal) | Storage primitives, audit append, batch-run dispatcher |
| `server-http` | `domain-*`, `workflow-*` | `Router` definitions; no http server binding |
| `server-ws` | `domain-*`, `infra-jobs` | WebSocket server + broadcaster API |
| `server-app` | `server-http`, `server-ws` | Binary entry point: starts http + ws, mounts routes |
| `ui-studio` | `server-app` (only for proxy URL) | Vite-built static bundle |

Allowed cycles: none. `tsc --build` enforces this via project references.

---

## Migration plan — 10 sub-steps, tag-per-step

Same execution pattern that worked for the v1 → v2 port (M1–M8, 12 tags). Each step preserves the running app via re-export shims in the old file locations.

| Step | Move | Tag |
|---|---|---|
| O1 | Workspace root, `tsc -b` setup, biome / eslint config, one demo package to validate the toolchain | `org-0.1.0` |
| O2 | Extract `agent-core` + `agent-provider` + the two concrete providers | `org-0.2.0` |
| O3 | Extract `mcp-core` + `mcp-tools-*` + `mcp-server-*` | `org-0.3.0` |
| O4 | Extract `infra-*` (`batch-run`, `jobs`, `audit`, `storage`) | `org-0.4.0` |
| O5 | Extract `domain-*` (already factored as subdirs in v1; promote to packages) | `org-0.5.0` |
| O6 | v2's `modules/{1..6}/` → `pipeline-*` packages | `org-0.6.0` |
| O7 | v2's `workflows/` → `workflow-*` packages | `org-0.7.0` |
| O8 | Skills become packages with `package.json`; build a skill-discovery loader | `org-0.8.0` |
| O9 | Split server into `server-http` / `server-ws` / `server-app` | `org-0.9.0` |
| O10 | UI as `ui-studio` package; archive v1 monorepo; final tag | `org-1.0.0` |

Each step has the same shape:

1. Create the new package directory under `packages/<name>/`.
2. Move source files in; add `package.json` declaring dependencies on other workspace packages.
3. Replace the old file location with a re-export shim that imports from the new package.
4. Run `npm run typecheck` across the workspace; fix any cross-package import that became invalid.
5. Run `npm run smoke` for end-to-end validation.
6. Commit + tag.

Old call sites migrate to the new import paths opportunistically. By `org-1.0.0` the shims can be deleted.

---

## What this buys

1. **Adding a new provider** (e.g. Xuguang's IU-Agentic-Framework proxy): `packages/agent-provider-iuagentic/` implementing `AgentProvider`. Zero touches to existing packages.
2. **Adding a new skill** (e.g. radiology phenotype): `packages/skills/phenotypes/<name>/`. Auto-discovered by the skill loader.
3. **Adding a new workflow** (e.g. radiology report review): `packages/workflow-radiology/`. Reuses pipeline + agent-core + infra unchanged.
4. **Publishing** any package independently. `mcp-tools-chart-review` becomes an npm package consumable from any MCP-aware agent runtime. Phenotype skills become independently versioned.
5. **Cross-team collaboration**: the IU-Agentic-Framework convergence story becomes mechanical — Xuguang's framework imports `mcp-tools-chart-review` + `skills/chart-review*` as npm dependencies. No fork-and-modify.
6. **Test isolation**: each package has its own test suite that runs without booting the whole platform.
7. **Build observability**: `tsc --build` shows the dep graph. Cycles become impossible at compile time.

---

## Deferred / open questions

- **Python sidecar (`lib-py/`)**: keep as a single package with its own `pyproject.toml`, or split it the same way (`lib-py/chart-review-parser`, `lib-py/chart-review-derivation`, …)? Recommendation: keep flat for now; split only if we get a second Python consumer.
- **Skill schema**: should the per-skill `package.json` include a `chartReviewSkill` field declaring tool dependencies (e.g. "this skill needs `mcp-tools-chart-review.find_quote_offsets`"), so the runtime can refuse to activate a skill whose tools aren't loaded? Likely yes, but defer until skill packaging is in place.
- **Versioning policy**: do we use `changesets` for per-package SemVer, or keep one repo-wide version? Recommendation: changesets — the whole point of this restructure is to make packages independently consumable, and that needs independent versions.
- **Where the corpus lives**: it's currently inside the monorepo. Should it be a separate repo? Defer; it's only ~20 synthetic patients.
- **v1 archival**: at what point do we `rm -rf chart-review-platform/`? Recommendation: at the end of O5 (when `domain-*` is extracted), since by then nothing in v2 imports across the v1 boundary.

---

## Status — what was executed

Implementation arc tagged across `org-0.1.0` → `org-1.0.0` between
2026-05-11 and 2026-05-12.

**Tags + packages added per step:**

| Tag | Step | Packages added | Cumulative |
|---|---|---:|---:|
| `org-0.1.0` | O1: workspace scaffold + first demo | `agent-core` | 1 |
| `org-0.2.0` | O2: model-config + agent-compose | `model-config`, `agent-compose` | 3 |
| `org-0.3.0` | O3: agent provider stack | `agent-provider`, `agent-provider-claude`, `agent-provider-codex` | 6 |
| `org-0.4.0` | O4: data primitives | `contract-eval`, `platform-types`, `patients` | 9 |
| `org-0.5.0` | O5: leaf utilities | `fs-atomic`, `reviews-context`, `find-quote-offsets`, `faithfulness`, `storage`, `audit-trail` | 15 |
| `org-0.6.0` | O6: live-alerts + rubric + tasks + domain-review | `live-alerts`, `rubric`, `tasks`, `domain-review` | 19 |
| `org-0.7.0` | O7: MCP packages | `mcp-core`, `mcp-server-anthropic`, `mcp-server-stdio` | 22 |
| `org-0.8.0` | O8: 9 packages incl. domain aggregates | `lock`, `kappa`, `disagreements`, `agent-specs`, `criterion-hash`, `adjudications`, `domain-issue`, `domain-bundle`, `domain-cohort` | 31 |
| `org-0.9.0` | O9: jobs + batch-run + remaining domains | `jobs`, `infra-batch-run`, `domain-iter`, `domain-proposal` | 35 |
| `org-0.10.0` | O10a: deferred leaves; all cross-lib paths gone | `drift-detector`, `auto-role-c`, `dsl-validator`, `benchmark-generator`, `version-archive`, `migration`, `maturity`, `lock-test` | 43 |
| `org-0.11.0` | O10b: v2 pipeline + workflows | `v2-shared`, `pipeline-clarify`, `pipeline-form-gen`, `pipeline-discover`, `pipeline-extract`, `pipeline-validate`, `pipeline-correct-log`, `workflow-chart-review`, `workflow-lit-extract` | 52 |
| `org-0.12.0` | O10c: skills as workspace packages | 23 skill packages (`skill-chart-review`, `skill-chart-review-lung-cancer-phenotype`, …) | 75 |
| `org-1.0.0` | O10d: ui-studio + final | `ui-studio` | **76** |

**What landed in v2's final shape:**

```
chart-review-platform-v2/
├── packages/
│   ├── agent-core/                      provider-neutral types
│   ├── agent-compose/                   ComposeAgentOptions
│   ├── agent-provider/                  runAgent + factory + interface
│   ├── agent-provider-claude/           Anthropic SDK adapter
│   ├── agent-provider-codex/            Codex CLI subprocess adapter
│   ├── model-config/                    modelFor + describeAllModels
│   │
│   ├── mcp-core/                        transport-neutral handlers
│   ├── mcp-server-anthropic/            in-process MCP via claude-agent-sdk
│   ├── mcp-server-stdio/                stdio MCP via @modelcontextprotocol/sdk
│   │
│   ├── platform-types/                  PatientSummary, NoteListing, …
│   ├── patients/                        corpus accessor
│   ├── find-quote-offsets/              faithfulness primitive
│   ├── faithfulness/                    byte-offset validator
│   ├── audit-trail/                     JSONL append + read
│   ├── reviews-context/                 AsyncLocalStorage for reviewsRoot
│   ├── storage/                         atomicWriteJson, pathFor
│   ├── fs-atomic/                       writeJsonAtomic
│   ├── contract-eval/                   DSL evaluator
│   ├── live-alerts/                     cross-criterion alert recomputer
│   ├── rubric/                          phenotype skill bundle loader
│   ├── tasks/                           loadCompiledTask wrapper
│   ├── lock/                            computeTaskSha
│   ├── kappa/                           Cohen's κ
│   ├── disagreements/                   compareDrafts
│   ├── agent-specs/                     role preset registry
│   ├── criterion-hash/                  schema hash + rerun plan
│   ├── adjudications/                   writeAdjudication / listAdjudications
│   ├── drift-detector/                  agent answer drift threshold
│   ├── auto-role-c/                     auto-fire feedback on drift
│   ├── dsl-validator/                   DSL syntax checker
│   ├── benchmark-generator/             benchmark from rule proposals
│   ├── version-archive/                 archiveVersion + loadVersionedTask
│   ├── migration/                       runMigration
│   ├── maturity/                        guideline state machine
│   ├── lock-test/                       held-out cohort verification
│   │
│   ├── domain-review/                   review_state aggregate
│   ├── domain-iter/                     pilot iteration lifecycle
│   ├── domain-proposal/                 rule proposal lifecycle
│   ├── domain-cohort/                   deployment cohort + κ
│   ├── domain-issue/                    deployment-issues queue
│   ├── domain-bundle/                   reproducibility export
│   │
│   ├── infra-batch-run/                 batch-run primitive
│   ├── jobs/                            async job queue
│   │
│   ├── v2-shared/                       v2 contract types + dsl + logger
│   ├── pipeline-clarify/                NL → TaskSpec
│   ├── pipeline-form-gen/               TaskSpec → FormSpec
│   ├── pipeline-discover/               Subject → EvidenceUnit[]
│   ├── pipeline-extract/                agent runtime composer
│   ├── pipeline-validate/               reconciler + judge adapter
│   ├── pipeline-correct-log/            audit JSONL writer
│   ├── workflow-chart-review/           chart-review composition
│   └── workflow-lit-extract/            lit-extract composition
│
├── client/                              @chart-review/ui-studio (React)
│
├── .agents/skills/                      23 skill packages (workspace)
│   ├── chart-review/                    @chart-review/skill-chart-review
│   ├── chart-review-lung-cancer-phenotype/
│   ├── chart-review-judge/
│   └── …
│
└── server/
    ├── index.ts, ws.ts, builder-bridge.ts   v2-native HTTP + WS + builder
    ├── *-routes.ts                          v2 route surface (~150 endpoints)
    └── lib/                                 platform internals (shims + leftover impl)
```

**Remaining work (not gating org-1.0.0):**

- `server-http` / `server-ws` / `server-app` split — currently `server/`
  holds the route table + WS server + Express bridge as one unit. Could
  be split for clarity but works as-is.
- A few `lib/` files still hold implementation (judge, judge-batch,
  methods-drafter, codify, feedback, qa-panel, ai-client, chat-store,
  session, builder-routes, builder-session, builder-state,
  deployment-kappa, guideline-calibration, prelock-summarizer,
  override-suggester, etc.). These are legitimate "platform internals"
  that compose the packages — converting each to a package is mechanical
  but low-value at this stage; the cross-package boundary invariant
  already holds (no relative-path imports between packages and lib/).

**Verified at every step:**

- `npm run typecheck` clean
- `/api/runtime` + representative routes return 200
- `npx tsx` resolves `@chart-review/*` imports correctly
- v2 dev server starts and the React Studio loads via `http://localhost:5174`

---

## Out of scope for this proposal

- Changing how skills are loaded at runtime (the file-walking discovery mechanism stays; only the location changes).
- Replacing the MCP wire protocol (we use the standard `@modelcontextprotocol/sdk`).
- Switching from TypeScript to Rust. Codex's choice of Rust is driven by single-binary distribution + low-latency local IPC; our deployment model (server + browser UI) doesn't need that.
- Replacing the React UI framework.

---

## Related design docs

- `chart-review-platform-v2/PORTING_ROADMAP.md` — the M1–M8 v1 → v2 port (completed, tags `v2-0.4.0` through `v2-1.0.0`)
- `chart-review-platform/README.md` — design narrative for the current platform
