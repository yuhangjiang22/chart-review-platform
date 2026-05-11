# chart-review-platform-v2 (MVP scaffold)

Pluggable 6-module pipeline shared between the chart-review and
lit-extract workflows. **This is a scaffold, not a port.** Module
contracts are real and typed; implementations are deliberately minimal
(stub extractors, fixture-backed discovery) so the structure is
exercisable end-to-end without spending tokens or wiring real LLM
calls yet.

The end-state goal: replace the chart-review-platform v1 server with
v2 *and* fold lit-extract into the same pipeline, with the shared
mechanics (faithfulness gate, dual-extractor + judge, append-only
audit) living in one place.

See [`docs/workflow-comparison.md`](../docs/workflow-comparison.md) for
the analysis that motivated this split.

## The 6 modules

```
TaskSpec → FormSpec → Corpus → ExtractorOutput[] → ReconciledDraft → FinalizedAssessment
   ↓          ↓         ↓             ↓                  ↓                   ↓
1. clarify  2. form   3. discover  4. extract        5. validate         6. correct + log
                                  (×N parallel)     (reconcile + judge)  (human override + audit)
```

| # | Module | Chart-review adapter | Lit-extract adapter | Reused from v1? |
|---|---|---|---|---|
| 1 | `clarify` | phenotype scope (minimal) | PICO scope (minimal) | No — v1's `builder/` is to-be-replaced |
| 2 | `form-gen` | **loads v1's compiled task via `loadCompiledTask`** | hard-coded extraction form | **Yes** — `CompiledField` shape + task store |
| 3 | `discover` | patient-cwd note reader | DB / fixture fetcher | Partial — same file layout as v1's corpus |
| 4 | `extract` | stub + `makeV1AgentExtract` adapter that **wraps v1's `runAgent`** | stub | **Yes** — Claude/Codex provider, MCP, per-run dropdown |
| 5 | `validate` | — | — | **Yes** — wraps v1's `compareDrafts` (hard/soft kinds, fingerprint) |
| 6 | `correct-log` | — | — | Partial — replicates override semantics + edit_reason taxonomy |
| — | DSL evaluator | (used by 5 when applicability/derivation present) | (same) | **Yes** — re-exports v1's `safeEval`, `evalDerivation`, `fieldApplicability` from `contract-eval.ts` |

What's v1-imported via cross-project relative paths from `../chart-review-platform/app/server/`:

```ts
// types
import { EvidenceRef, FieldAssessment, AgentDraft, ... } from ".../disagreements.js";
import { CompiledField, CompiledTask } from ".../tasks.js";
import { ProviderName, AgentRunInput, ... } from ".../agent-provider.js";

// behavior
import { compareDrafts } from ".../disagreements.js";
import { loadCompiledTask } from ".../tasks.js";
import { runAgent } from ".../agent-provider.js";
import { safeEval, evalDerivation, fieldApplicability } from ".../contract-eval.js";
```

v2's `node_modules` is a symlink to v1's so transitive deps (Anthropic
SDK, MCP SDK, etc.) resolve at runtime.

Three things still NOT reused that should be (port-when-ready):

- v1's `audit-trail.ts` `appendAuditEntry` — module 6 has its own JSONL writer; could thin to a re-export, but `audit-trail.ts` pulls in PLATFORM_ROOT side effects we kept module 6 isolated from.
- v1's `find-quote-offsets-impl.ts` — whitespace-tolerant offset matcher; module 4's faithfulness gate is currently strict-byte-match only.
- v1's `judge.ts` / `judge-batch.ts` — the LLM judge implementation; module 5 has the interface (`Judge`) but no built-in implementation yet.

## Layout

```
chart-review-platform-v2/
├── README.md
├── package.json
├── tsconfig.json
├── shared/
│   ├── types.ts             ← all 6 module contracts
│   └── logger.ts            ← append-only JSONL writer
├── modules/
│   ├── 1-clarify/{index, chart-review, lit-extract}.ts
│   ├── 2-form-gen/{index, chart-review, lit-extract}.ts
│   ├── 3-discover/{index, chart-review, lit-extract}.ts
│   ├── 4-extract/{index, faithfulness, stub}.ts
│   ├── 5-validate/{index, reconcile}.ts
│   └── 6-correct-log/{index, jsonl}.ts
├── workflows/
│   ├── chart-review.ts      ← wires the 6 modules with chart-review adapters
│   └── lit-extract.ts       ← wires the 6 modules with lit-extract adapters
└── examples/
    └── smoke-test.ts        ← runs both workflows end-to-end
```

## Try it

```sh
cd chart-review-platform-v2
npm install
npm run typecheck            # confirm contracts compile
npm run smoke                # exercise all 6 modules, both workflows
```

The smoke test:

1. Builds a 1-patient corpus + 1-paper fixture in a temp dir.
2. Runs `makeChartReviewPipeline.runOne()` end-to-end → emits a
   `FinalizedAssessment`.
3. Runs `makeLitExtractPipeline.runOne()` end-to-end → emits a
   `FinalizedAssessment`.
4. Records a human `confirm` + an `override` on each → audit log JSONL.
5. Asserts both audit logs exist with the right number of entries.

If the smoke test passes, the 6 module contracts are consistent enough
to drive both workflows.

## What's intentionally absent (MVP scope)

- **Real LLM calls.** Module 4 uses a deterministic stub extractor.
  The real implementation lives in v1's `agent-provider-{claude,codex}.ts`;
  port it behind the `ExtractModule` interface when ready.
- **Real discovery sources.** Module 3's lit-extract adapter falls back
  to a fixture file; PubMed/Europe PMC/arXiv adapters go behind the
  same `DiscoverModule` interface.
- **Real form-gen.** Module 2 emits a small hard-coded rubric per
  domain. The chart-review side should later compile from existing
  `.claude/skills/chart-review-<task>/criteria/*.yaml`; lit-extract
  should drive the Phase-5 interview.
- **HTTP / UI / WebSocket.** v1's React Studio sits on top; v2 starts
  as a Node library. Building a UI on the same module contracts is a
  later step.
- **The applicability + derivation DSL.** Reserved in `Criterion`
  but not evaluated yet — port v1's `contract-eval.ts` behind the
  reconciler/form-gen interface when porting in real criteria.

## Implementation order (the smallest first-useful-version path)

1. ✅ Types-only commit — the 6 contracts in `shared/types.ts`.
2. ✅ Logger module — the append-only JSONL writer both workflows share.
3. ✅ Discovery adapters — patient-notes + (fixture for now, PubMed later).
4. **Next**: real `ExtractModule` adapters — port `agent-provider-{claude,codex}.ts` behind the interface, drop the stub.
5. **Next**: real `Judge` (optional pre-screen) — port v1's `judge.ts`.
6. **Next**: real form-gen — port v1's task compiler; add the
   applicability + derivation DSL evaluator behind module 5's
   `reconcile()` so derived cells flow through the same pipeline.
7. **Later**: an HTTP server + UI on top, replacing v1's Studio.

## What to delete from v1 once v2 covers the same ground

(Pointers, not actions — wait until v2 actually replaces them.)

- `chart-review-platform/app/server/skills/keyword-search/` — predecessor of smart-search.
- `chart-review-platform/builder/` chat builder — replaced by a Phase-1-style structured clarify module.
- Lit-search's free-form correction reasons — replaced by the structured `edit_reason` enum.
- Lit-search's "Google Scholar / general web" sources — low signal; lit-extract adapter doesn't include them.
