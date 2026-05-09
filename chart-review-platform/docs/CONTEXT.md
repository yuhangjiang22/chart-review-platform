# CONTEXT — chart-review-platform vocabulary

Canonical terms for this repo. Update this file as new terms crystallize during architectural conversations or domain discussions. Code, tests, route names, types, skills, and docs should use these terms — not paraphrases.

This is the single source of truth for the methodology vocabulary. When `field_id` and `criterion_id` mean the same thing in the codebase, the term in this file is the one new code uses. Old code migrates over time; this file does not.

---

## Methodology vocabulary

### Phase

The platform is structured around four sequential lifecycle phases. Each phase is a real partition of code, data, and skills:

- **Calibration phase** — iterative drafting and tightening of the rubric. Pilot Iters run; reviewers validate; auto-critique surfaces proposals; methodologist accepts. Continues until inter-rater κ stabilises and lock-test passes.
- **Lock phase** — sealing the rubric at a specific git SHA. The locked SHA is citeable and reproducible. Lock is a discrete event, not a phase the platform spends time in.
- **Deployment phase** — running the locked rubric against a real Cohort. Issues are filed; a stratified Sample is drawn; reviewers validate; deployment κ is computed.
- **Publication phase** — exporting a Bundle, drafting Methods text, citing the locked SHA in the manuscript.

Cross-phase code (e.g., promote-to-iter loops a deployment Issue back into a calibration Iter) lives at explicit cross-phase seams. Within-phase modules don't reach into other phases' internals.

### Rubric

The structured definition of "what to abstract from a chart and how." Concretely, a Rubric is the directory `guidelines/<task_id>/` (or its skill-format equivalent under `.claude/skills/chart-review-<task>-phenotype/`) containing:

- `meta.yaml` — task-level metadata
- `criteria/*.yaml` — one Criterion definition per file
- Optional `code_sets/`, `keyword_sets/`, `edge_cases/`, `exemplars/` carrying domain data

A Rubric has lifecycle states `draft → locked` (and possibly `superseded` after a future lock). Locked Rubrics are immutable.

### Criterion

A single evaluation unit in a Rubric. Each Criterion has a `criterion_id` (currently called `field_id` in code; the rename is pending), an `answer_schema` describing what answers are valid (boolean / enum / number / null), and prose `definition` + `extraction_guidance` + `examples`. Criteria can be **leaf** (extracted directly from the chart) or **derived** (computed from other Criteria via a `derivation` expression).

A Criterion's `schema_hash` is a sha256 over its structural fields (excluding prose). It governs criterion-level rerun and adjudication carry-forward — when the schema_hash hasn't changed, the prior answer carries forward.

**Atomicity.** A Criterion must be **atomic**: one decision, one answer schema, one time scope, one source class (or explicit derivation), one resolved meaning, independently revisable, with gate vs answer separated via `is_applicable_when`. Atomicity is enforced at authoring time and is the load-bearing precondition for per-criterion κ, criterion-level rerun, schema_hash carry-forward, and adjudication granularity. The full definition + seven-item checklist + common violations + how to split them lives in `.claude/skills/chart-review/references/atomic-criteria.md`. The pragmatic test: two reviewers giving the same answer to a Criterion must mean they agree on the same thing — full stop. If they could agree for different reasons, the Criterion is too coarse and must be split.

### Batch Run

The shared primitive that all three lifecycles call into: invoke the agent against N patients, write per-patient Agent Drafts, return when finished. A Batch Run owns nothing about *why* the run is happening (calibration vs lock-test vs deployment) — only the mechanics of running the agent.

Lives at `infra/batch-run/`. Today's `runs.ts` is roughly this shape with non-primitive concerns mixed in.

A Batch Run is consumed by **exactly three** lifecycle owners: the Calibration Iter (which auto-critiques afterward), the Rubric Lock-test function (which evaluates eligibility afterward), and the Cohort run (which prepares for sample validation afterward). The Batch Run does not know which of the three called it.

### Pilot Iter

One round of agent runs + reviewer validation + auto-critique within the Calibration phase. An Iter is the unit of incremental rubric tightening. Each Iter has:

- An iter_id (`iter_NNN`, sequential)
- A Run that produces per-patient Agent Drafts
- Reviewer Validations of those drafts
- A Disagreement set (when ≥2 agents ran)
- Adjudications (methodologist resolutions of Disagreements)
- A critique that clusters Adjudications into Rule Proposals
- An eligibility check against the lock-test threshold

Iters are **linear** — there's no branching. iter_002 always succeeds iter_001 in time. The Iter is the platform's conceptual centerpiece; most platform work is iter-shaped.

### Cohort

A patient set defined for a specific study. Distinct from `dev_patient_ids` (which is a small calibration-phase slice; lives inside the Rubric directory). A Cohort lives at `cohorts/<cohort_id>/manifest.json` and pins the `task_id`, the `guideline_sha` it targets, and the patient_ids. Cohorts are the unit of Deployment — you run an agent against a Cohort, draw a Sample, validate the Sample.

### Sample

A stratified subset of a Cohort drawn for blinded reviewer validation. Stored at `cohorts/<id>/sample/selections/<run_id>.json`. The Sample's reviewer Validations produce the deployment κ that goes into the methods section.

### Review vs Validation

Same on-disk shape (`review_state.json`); different lifecycle position.

- **Review** — a reviewer's per-patient assessments during Calibration phase. Lives at `reviews/<pid>/<task>/review_state.json`.
- **Validation** — a reviewer's per-patient assessments during Deployment phase, against a Sample. Lives at `cohorts/<id>/sample/validations/<pid>/<task>/review_state.json` (single-reviewer) or `.../sample/validations/<pid>/<task>/<reviewer_id>/review_state.json` (multi-reviewer with consensus).

The data model is identical; the names mark *when* the assessment was made.

### Adjudication

A methodologist's resolution of a Disagreement (when two agents in an Iter give different answers for a Criterion). Adjudications are the input to the auto-critique that surfaces Rule Proposals. They carry both the resolved answer and a `classification` describing why the agents disagreed (`agent_error`, `data_issue`, `guideline_gap`, etc.).

### Validated cell

A single (patient × criterion) pair that a reviewer has explicitly confirmed. A cell is **validated** when both of the following conditions are true on the same `review_state.json` file:

1. `field_assessments[].updated_by === "reviewer"` for the criterion in question — the reviewer wrote or overrode the field assessment.
2. The top-level `review_status` is `"reviewer_validated"` or `"locked"` on that patient record.

Canonical source of truth: the `review_state.json` files under `reviews/<patient_id>/<task_id>/`. The `GET /api/guideline-improvement/:taskId/cell-count` endpoint implements this definition and is the authoritative count surfaced in the DECIDE phase. Secondary caches (oracle.json, per-iter registry) must not be used as the source of truth — they are invalidated on every review_state write.

### Rule Proposal

A draft edit to the Rubric, generated by auto-critique from clustered Adjudications OR by the `chart-review-improve` skill. Lives at `proposals/<task>/<id>.yaml`. Has lifecycle `draft → accepted | rejected`; accepted proposals leave a paper trail with diff vs the Rubric. Methodologist approves each one explicitly — proposals never auto-apply.

Proposals outlive the Iter that surfaced them — the Methodologist may accept a proposal weeks later, possibly after subsequent Iters have run. Therefore Proposals live in their own module (`domain/proposal/`), not inside `domain/iter/`. The Iter only triggers proposal generation; it does not own the proposals themselves.

### Evidence

A pointer to where in the chart a Criterion's answer comes from. Two shapes:

- **Note evidence** — `{source: "note", note_id, span_offsets, verbatim_quote}`. The `find_quote_offsets` MCP tool produces these by anchoring a sentence to a chart note.
- **OMOP evidence** — `{source: "omop", table, row_id, concept_id, concept_name}`. Cites a row in the structured-data tables.

Evidence is required on every assessed Criterion (the **Faithfulness** discipline). Reviewers can verify Evidence by clicking through; auditors can reproduce.

### Faithfulness

The platform's discipline that every agent-asserted Criterion answer must cite Evidence that resolves to a real chart artifact. Verified at write time; agents that produce assessments without resolvable Evidence are rejected.

### Adjudication carry-forward

When a Criterion's `schema_hash` doesn't change between Iter N and Iter N+1, the Adjudications from Iter N apply to Iter N+1 — reviewers don't re-adjudicate the same Criterion answer twice. Driven by the `criterion-hash` module.

### Deployment Issue

A field issue filed by a reviewer or end-user against a deployed locked Rubric. Stored append-only at `deployment-issues/<guideline_sha>.jsonl`. Has triage state (`dismiss / agent_error / data_issue / guideline_gap`) and optional promotion state (which next Iter it was folded into).

### Promote-to-iter

The cross-phase action that takes a batch of triaged Deployment Issues (those with `agent_error` or `guideline_gap` triage) and creates a new calibration-phase Pilot Iter from their patients. Closes the deployment → calibration loop.

### Bundle

A self-describing tarball under `exports/<task>/<ts>/` containing the locked Rubric + reviewer locks at that SHA + Runs + Adjudications + Rule Proposals + deployment Cohorts/Samples/Validations/κ reports + Deployment Issue log. The unit of reproducibility for IRB packets and replication.

### Methods draft

A past-tense, third-person prose draft of the academic Methods section, generated by the `chart-review-methods` skill from a Bundle. Has a 4- or 5-paragraph structure (5 when a deployment-κ report exists).

---

## Architectural vocabulary

Per [LANGUAGE.md](../LANGUAGE.md) (in the architecture-improvement skill). Quick reference:

- **Module** — anything with an interface and an implementation; scale-agnostic
- **Interface** — everything a caller must know (types, invariants, ordering, errors, config)
- **Depth** — leverage at the interface; deep = lots of behaviour behind a small interface
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place
- **Adapter** — a concrete thing satisfying an interface at a seam
- **Locality** — change, bugs, knowledge concentrated at one module
- **Leverage** — capability per unit of interface callers must learn

Use these instead of "service / boundary / component / API."

---

## Target module shape

The platform converges toward concept-aligned modules with thin adapters at the edges:

```
domain/
  iter/         ← Calibration-phase Pilot Iter ONLY (not lock-test, not cohort run)
  cohort/       ← Cohort + Sample + Validation
  review/       ← pure state-transition core; effects as adapters
  rubric/       ← Rubric + Criterion + Lock + Lock-test (as a function) + schema_hash
  proposal/     ← Rule Proposals: generation (auto-critique + skill), lifecycle, persistence
  issue/        ← Deployment Issue + triage + promote loop
  bundle/       ← Reproducibility export

infra/
  batch-run/    ← shared primitive: agent against N patients, return drafts.
                ← Called by domain/iter, domain/rubric (lock-test), domain/cohort.

adapters/
  http/         ← thin route handlers; one per domain module
  mcp/          ← MCP tool gateways (same shape as http/)
  fs/           ← filesystem reads/writes; one override pattern

ui/             ← v2 React Studio; presents domain concepts
skills/         ← agent-side skills; already concept-aligned
```

Today's structure differs:

- The HTTP edge isn't separate from orchestration (`server.ts` carries 118 routes with embedded business logic).
- The Pilot Iter has no module that owns it — its lifecycle is dispersed across 6 files.
- Side effects (audit append, alert recompute, drift check) are mixed into transition functions instead of living at named seams.

The 5 deepening opportunities discussed in conversation map onto this target:

1. Lift Iter lifecycle into a `domain/iter/` module
2. Lift route-handler orchestration into domain modules; thin `server.ts`
3. Split `applyUiAction` in `review-state.ts` into pure core + side-effect adapters
4. Repo-wide rename `field_id` → `criterion_id`; this file pins the term
5. Delete the legacy-format fallbacks (dual loaders for Rubric, Agent Draft, Issue)

No big-bang rewrite is planned. Each refactor lands independently in priority order.

---

## Skill development notes

### Skill content is session-cached

When the chart-review-build (or any other) skill is invoked via the Skill
tool inside a long-running conversation, the SKILL.md content is loaded
once at session start and cached for the rest of the session. Edits to
the file on disk after that point do NOT propagate into the running
session — the agent continues to see the pre-edit content.

For empirical end-to-end testing of skill prompt changes (e.g. a new
hard rule), open a fresh conversation. The cached version is fine for
reading the existing skill content, but it does not reflect mid-session
edits.
