# Chart Review Platform

Agent-enhanced clinical chart review, with the **methodological discipline** of a peer-reviewed phenotype validation study.

A methodologist drafts a structured rubric. Two agents (a "default" and a "skeptical" reviewer) read each patient's chart and answer the rubric independently. Their disagreements are treated as a discovery signal for guideline ambiguity, adjudicated by the methodologist, and clustered into proposed rubric edits. The rubric tightens until inter-rater κ stabilizes; it locks at a specific git SHA; **codify** then mines the validated calibration cohort for keyword / code / note-type anchors so subsequent agent runs are cheap and deterministic; the locked + codified rubric runs against a real cohort; a stratified sample of that cohort gets human-validated to produce the publishable accuracy number; the locked SHA + every artifact of the process exports as a reproducibility bundle.

**The platform's job is to keep the methodology honest while making each step cheap.**

---

## Quick start

```sh
cd chart-review-platform/app
cp .env.example .env
# Edit .env: set ANTHROPIC_AUTH_TOKEN to your OpenRouter API key
npm install
npm run dev
```

Express + WebSocket backend on `:3001`; Vite frontend on `:5173` (proxies `/api` and `/ws`). Open http://localhost:5173 → land on Studio.

The reference rubric `lung-cancer-phenotype` ships with a 20-patient synthetic corpus, so the platform is end-to-end runnable on a fresh checkout with no patient data of your own.

### Verified models (via OpenRouter)

| Model | Status | Notes |
|---|---|---|
| `anthropic/claude-haiku-4.5` | **Default** | $0.23 / agent-run, 100% citation coverage, 88s wall clock |
| `anthropic/claude-sonnet-4.6` | Recommended for adjudication | Higher quality reasoning, ~5× cost |
| `deepseek/deepseek-v4-pro` | Verified working | ~3-4× slower than Haiku; dominated by Sonnet on price-adjusted quality |

Per-pilot model picker UI lets you override `CHART_REVIEW_MODEL` per agent without editing `.env`.

### Tests

```sh
npm test                 # vitest (server + client unit tests)
npm run test:e2e         # Playwright end-to-end (~6 min, ~$0.45 LLM cost)
```

Python side:

```sh
cd lib && python3 -m pytest      # parser, derivation evaluator, faithfulness, parity tests
```

---

## The methodology in one diagram

```
┌─────────────┐    ┌──────┐    ┌────────┐    ┌─────────────┐    ┌─────────────┐
│ Calibration │ ─▶ │ Lock │ ─▶ │ Codify │ ─▶ │ Deployment  │ ─▶ │ Publication │
└─────────────┘    └──────┘    └────────┘    └─────────────┘    └─────────────┘
  pilot iters       seal at     mine           run on real       export bundle
  N agents/iter     SHA;        validated      cohort            draft methods
  adjudicate        per-crit    cohort for     (10s–10ks)        cite locked
  propose edits     schema_     keyword /      sample-validate   SHA + DOI
  → calibration κ   hash        code / note    → deployment κ
                                anchors;
                                update uses:
                                blocks

   draft rubric ───────────► locked + codified rubric ───────────► published κ + bundle
```

**Three κ numbers in order: calibration ≥ lock-test ≥ deployment.** The gap between the first and the last is the load-bearing finding for reviewers — does the rubric generalize? Codify never changes the rubric's semantics (it's bounded to anchor artifacts), so it sits between Lock and Deployment without re-opening calibration.

Full design: [`docs/OVERVIEW.md`](docs/OVERVIEW.md). Vocabulary: [`docs/CONTEXT.md`](docs/CONTEXT.md). Post-MVP architecture: [`docs/superpowers/specs/2026-05-03-post-mvp-blueprint.md`](docs/superpowers/specs/2026-05-03-post-mvp-blueprint.md).

---

## Design — atomic criteria + filesystem-as-state

Two load-bearing design principles run through everything else:

### 1. Atomic criteria

A **Criterion** is the smallest indivisible review unit: one decision, one answer schema, one time scope, one source class (or explicit derivation), one resolved meaning. Atomicity is enforced at authoring time and is the precondition for per-criterion κ, criterion-level rerun, schema_hash carry-forward, and adjudication granularity. The seven-item authoring checklist + common violations + applicability patterns + outcome-vs-reason axis split live in [`.claude/skills/chart-review/references/atomic-criteria.md`](.claude/skills/chart-review/references/atomic-criteria.md).

A criterion's `schema_hash` is sha256 over its structural fields (excluding prose). When the hash hasn't changed across iterations, the prior agent draft and the prior methodologist adjudication carry forward. Prose-only edits (definition tightening, new examples) don't invalidate prior work.

### 2. Filesystem-as-state

The platform has two halves — Node/TypeScript backend + React frontend (`app/`), and a Python library + CLI (`lib/`) — that **coordinate through the filesystem**, not in-memory. Both the agent (via in-process MCP tools) and the reviewer (via REST) write to the same `review_state.json`. Every read is from disk; every write is atomic + version-checked. Faithfulness is verified at the gateway: an agent that cites text that doesn't exist at the claimed offsets has its write rejected.

This makes the platform **scriptable** (any artifact is a file you can grep / diff / git-track) and **observable** (every iter's drafts, disagreements, adjudications, and proposals sit on disk for inspection).

### 3. Architecture (target shape)

```
domain/
  iter/         Calibration-phase Pilot Iter
  cohort/       Cohort + Sample + Validation
  rubric/       Rubric + Criterion + Lock + schema_hash
  proposal/     Rule Proposals: generation, lifecycle, persistence
  issue/        Deployment Issue + triage + promote-to-iter loop
  bundle/       Reproducibility export
  review/       Pure state-transition core; effects as adapters

infra/batch-run/     Shared primitive: agent against N patients
adapters/{http,mcp,fs}/   Thin edges
ui/                  v2 React Studio
.claude/skills/      Agent-side skills
```

Some of today's code still mixes orchestration into route handlers; the `domain/`/`adapters/` split is the target the recent `arch-r1` refactors have been moving toward.

---

## Workflow — what a methodologist actually does

### Phase 1: draft the rubric

Open Studio → Builder. Either:

- **Interactive** — `chart-review-build` skill walks the methodologist through a structured 7-phase interview (intake → output shape → population & index → criteria → evidence rules → edge cases → optional code/keyword sets) and writes the YAML at the end. Pushes back on compound criteria, outcome+reason enums, and gate-by-prose anti-patterns.
- **Batch** — `chart-review-author` skill ingests a published guideline / SOP / paper and drafts the YAML package in one pass.

Output: `.claude/skills/chart-review-<task-id>/{SKILL.md, meta.yaml, references/criteria/<field_id>.md (one atomic markdown per criterion with YAML frontmatter), references/code_sets/, references/keyword_sets/, references/edge_cases/}`. **All chart-review skills — drafts, calibrated, locked — live at this single canonical path.** Draft maturity is signaled by `status: draft` in `meta.yaml`, not by directory location; locking is a status flip, not a directory rename. The reviewer's loader walks `references/criteria/*.md` and parses YAML frontmatter — pure YAML criteria at the package root or under `criteria/` are silently ignored. See `.claude/skills/chart-review-build/references/file-templates.md` for canonical shapes.

For guideline-concordance rubrics (NCCN / AHA / ADA / CMS / USPSTF), the build skill ships a six-layer recipe: anchor leaf → step evidence leaves → applicability gate helpers → per-step concordance derivations → `count_true` rollups → final concordance category. See [`.claude/skills/chart-review-build/references/interview-guide.md`](.claude/skills/chart-review-build/references/interview-guide.md).

### Phase 2: pilot iterate (calibration)

In Studio → Pilots:

1. Configure a pilot iter: N agents (default + skeptical), patient set (start with 5–10 from `corpus/patients/`), model.
2. **Run.** Each agent writes per-patient drafts to `runs/<run_id>/per_patient/<pid>/agents/<agent_id>.json`.
3. **Disagreement extraction.** Pairwise comparison emits `.claude/skills/chart-review-<task>/pilots/iter_NNN/disagreements.json`.
4. **Adjudicate.** Patient-first surface: side-by-side dual drafts, 4-option form per disagreement (guideline gap / Agent 1 error / Agent 2 error / true clinical ambiguity). Auto-collapses agreed criteria (random-sample expansion every 5th patient validates one agreed criterion).
5. **Auto-critique.** `chart-review-improve` clusters guideline-gap adjudications into rule proposals at `proposals/<task>/<id>.yaml`.
6. **Accept / reject** proposals through the Rules tab. Methodologist signs each one.
7. **Calibrate.** `chart-review-calibrate` computes per-criterion Cohen's κ from blind dual-reviewer samples; reports which criteria fail the κ threshold. Surface those to `chart-review-improve` to act on.

Iterate (criterion-level rerun: only changed criteria re-invoke the agent; unchanged criteria carry forward by `schema_hash`). Cost per iter on 5 patients ≈ $1.10 with `claude-haiku-4.5`.

### Phase 3: lock

Once κ stabilizes and the lock-test eligibility passes, **lock** the rubric. The platform pins `guideline_sha` in `maturity.json`. From this point the rubric is citeable; methods sections cite the SHA, not "the latest version." Backward transitions are deliberate human actions.

### Phase 3.5: codify

`chart-review-codify` mines the now-locked rubric's validated calibration cohort for **efficiency anchors**: keyword sets (terms reviewers actually cited), code sets (OMOP concepts that gated reviewer answers), and note-type filters (which note types each criterion's evidence concentrated in). Anchors land at `references/{keyword_sets,code_sets,note_type_filters}/`; each criterion's `uses:` block is updated to point to the anchors that gate its searches. Subsequent agent runs use these as prefilters — no LLM call needed to discover that "C34.1" is in scope or that pathology reports matter for `pathology_lung_primary` — making cohort-scale runs an order of magnitude cheaper.

Codify is bounded to anchor artifacts only — it never modifies criterion shape, prompts, or derivations. Re-running codify on the same locked SHA is idempotent. If the rubric is revised + re-locked, codify re-runs against the new validated cohort.

### Phase 4: deploy + sample-validate

In Studio → Cohorts:

1. Define a cohort against a locked `guideline_sha`: `cohorts/<cohort_id>/manifest.json` pins the patient set.
2. Run the agent against the cohort.
3. Draw a stratified sample (~50 patients, balanced agent-positive vs agent-negative).
4. Reviewers (single or multiple, with majority-vote consensus) validate the sample — same per-patient form as calibration, but stored under `cohorts/<id>/sample/validations/`.
5. **Deployment κ** is the agent-vs-reviewer-consensus agreement on the sample. With 95% CI. The number that goes in the methods section.

### Phase 5: deployment issues + re-pilot

In production, end-users flag wrong cases through the Issues tab. Methodologist triages each (`dismiss / agent_error / data_issue / guideline_gap`). The `promote-to-iter` action takes a batch of `agent_error` + `guideline_gap` issues and creates a new calibration-phase pilot iter from their patients — closing the deployment → calibration loop.

### Phase 6: publish

`chart-review-methods` skill drafts a past-tense, third-person Methods section (~300–500 words, four or five paragraphs depending on whether deployment-κ exists) from the locked rubric + cohort QA stats. The reproducibility bundle exports a self-describing tarball under `exports/<task>/<ts>/` containing the locked rubric + reviewer locks at SHA + runs + adjudications + proposals + cohorts + samples + validations + κ reports + issue log. Methods cite `<sha>` + bundle DOI.

---

## Repo layout

```
chart-review-platform/
├── app/                          Node/TypeScript backend + React frontend
│   ├── server/
│   │   ├── domain/               iter/ cohort/ rubric/ proposal/ issue/ bundle/ review/
│   │   ├── infra/batch-run/      Shared agent-against-N-patients primitive
│   │   ├── adapters/http/        Thin route handlers
│   │   └── ...                   ai-client, contract-eval, criterion-hash, deployment-kappa, ...
│   ├── client/src/               React 18 + Tailwind + Radix Studio UI
│   ├── e2e/                      Playwright end-to-end tests
│   └── scripts/                  smoke-* harnesses, parity dump, model diagnostics
├── lib/                          Python package
│   └── chart_review/
│       ├── parser.py             Markdown task → CompiledTask dict
│       ├── validator.py          jsonschema validation
│       ├── derivation.py         Pure-interpreter expression evaluator (TS port at app/server/contract-eval.ts)
│       ├── faithfulness.py       Quote/offset verification
│       ├── alerts.py             Cross-criterion contradiction detectors
│       └── cli.py                `chart-review` command
├── contracts/                    Canonical JSON Schemas
├── corpus/patients/              20-patient deidentified test corpus
├── runs/                         Per-iter agent invocations (gitignored)
├── reviews/                      Per-patient review state (gitignored)
├── cohorts/                      Cohort manifests + samples + validations
├── proposals/                    Pending and accepted rubric edits
├── exports/                      Reproducibility bundles
├── deployment-issues/            Append-only issue log per locked SHA
├── prompts/agent_roles/          default.md, skeptical.md role-prompt presets
├── docs/                         OVERVIEW.md, CONTEXT.md, USER_MANUAL.md, superpowers/specs/
└── .claude/skills/               Ten lifecycle skills + per-rubric scope skills.
    └── chart-review-<task-id>/   Each rubric package lives here:
        ├── meta.yaml             status: draft | calibrated | locked | deployed
        ├── references/criteria/  one .md per atomic criterion (frontmatter + body)
        ├── references/{code_sets,keyword_sets,edge_cases}/  codify-produced anchors
        ├── pilots/iter_NNN/      per-iter manifests + adjudications + critique
        └── versions/             historical snapshots
```

Most session artifacts (runs, reviews) are gitignored; what's tracked is the rubric + the methodology.

---

## Agent skills

Ten skills, organized by lifecycle phase:

| Phase | Skill | Purpose |
|---|---|---|
| Draft | `chart-review-build` | Interactive 7-phase rubric-authoring interview. Pushes back on non-atomic criteria, outcome+reason enums, gate-by-prose. |
| Draft | `chart-review-author` | Batch rubric drafting from a published guideline / SOP / paper, in one pass. |
| Calibrate | `chart-review` | Reads a patient's chart, answers the rubric, cites evidence verbatim, commits via MCP tools. The most-edited file in the repo; per-patient behavior tuning happens here. |
| Calibrate | `chart-review-copilot` | Read-only copilot for the human reviewer during validation. Explains agent reasoning, retrieves evidence, helps document overrides. |
| Calibrate | `chart-review-improve` | Clusters disagreements + override patterns into rubric-edit proposals at `proposals/<task>/<id>.yaml`. |
| Calibrate | `chart-review-calibrate` | Computes per-criterion Cohen's κ from blind dual-reviewer samples. The release gate before lock. |
| Codify | `chart-review-codify` | Post-lock. Mines the validated calibration cohort for keyword / code / note-type anchors and updates each criterion's `uses:` block. Bounded to anchor artifacts; never edits criterion shape. |
| Deploy | `chart-review-cohort` | Cohort drift detection + override pattern analysis on the deployed cohort. Surfaces findings; doesn't auto-edit. |
| Publish | `chart-review-methods` | Drafts a past-tense, third-person Methods section from the locked rubric + cohort QA stats. Cites the locked SHA + bundle DOI. |
| Per-rubric | `chart-review-<noun>-phenotype` | Scope skill activated when reviewing a specific phenotype (e.g. `chart-review-lung-cancer-phenotype`). Carries the case definition, criteria, and any codify-generated anchors. |

---

## Reference

- **`docs/OVERVIEW.md`** — full project narrative; the canonical "what does this do and why" doc.
- **`docs/CONTEXT.md`** — methodology + architecture vocabulary. Pin canonical terms.
- **`docs/USER_MANUAL.md`** — end-user manual with screenshot tour.
- **`docs/manual/api-audit.md`** — API surface reference.
- **`docs/manual/skills-audit.md`** — skill inventory + activation rules.
- **`docs/superpowers/specs/`** — design documents in date order. Recent priorities:
  - `2026-05-02-agent-enhanced-chart-review-mvp.md` — dual-agent MVP (shipped)
  - `2026-05-03-post-mvp-blueprint.md` — lifecycle / deployment / validation / publication architecture
  - `2026-05-03-criterion-level-rerun-design.md` — efficient revision mechanism
  - `2026-05-03-model-benchmark-results.md` — 6-model OpenRouter benchmark
  - `2026-05-04-criterion-block-authoring-spec-disposition.md` — atomicity + structured prose decisions
- **`app/README.md`** — backend/frontend internals: API, WebSocket protocol, model routing, provider compatibility notes.

---

## Production considerations

The platform is research-grade on synthetic data. **For a real-EHR deployment** you must address:

1. **Isolation.** The Claude Agent SDK has access to Read/Glob/Grep + the in-process MCP tools. Run in a sandboxed container or restricted user account.
2. **PHI.** The bundled corpus is synthetic. Don't point at real EHR data without institutional BAA + IRB review.
3. **Persistent storage of chat history.** `chat-store.ts` is in-memory; chats are lost on restart. `review_state.json` IS persisted on disk (deliberately the durable surface).
4. **Authentication.** Token-based auth exists for viewer + deployment endpoints; the Studio surface is currently single-user. Multi-user with roles is post-beta scope.
5. **EHR integration.** Patients are ingested today as deidentified file bundles (`corpus/<pid>/notes/*.txt` + `omop/*.json`). Real-EHR ingestion is out of scope; the `patients.ts` adapter is the seam where it would land.
