# Chart Review Platform — Project Overview

*Updated: 2026-05-03. Audience: clinical research collaborators, methodologists, and engineers joining the project.*

## The problem

Clinical phenotyping research depends on **chart review** — a methodologist or clinical reviewer reads a patient's electronic health record and answers structured questions ("Does this patient have confirmed lung cancer? On what evidence?"). Chart review is the gold standard for validating phenotypes that go into epidemiology studies, registry construction, and outcomes research, but it has two long-running pain points:

1. **It's slow and expensive.** A trained reviewer takes 15–60 minutes per chart. A 1,000-patient study is months of wall clock and tens of thousands of dollars in reviewer time.

2. **The rubric (the question set + decision rules) is usually under-specified.** Reviewers reach different conclusions on the same chart because the protocol doesn't explicitly say what to do with hedged language, conflicting notes, copy-forwarded text, family history vs personal history, medications-as-proxy, and so on. The published methods section says "we used the McGowan criteria"; the actual reviewer behavior is partly tacit and irreproducible.

LLM agents can in principle accelerate chart review, but **deploying agents naively makes both problems worse** — the agent's tacit reasoning is even less transparent than a human reviewer's, and prompt-engineered shortcuts produce papers that look impressive on the calibration set and fail to generalize.

This platform is an attempt to do agent-enhanced chart review **without** introducing those failure modes — keeping the methodological discipline that makes chart review trustworthy in the first place.

---

## The methodological idea

The core principle is the spec we settled on in the early design sessions:

> **First define what should count as correct, then optimize how agents perform it, and only later optimize how to do it efficiently.**

Translated into the platform's three phases:

- **Phase 1 — Calibration.** The rubric is the primary object being calibrated, not the agent. We use **multiple independent agents** with different role framings (a "default" reviewer and a "skeptical" reviewer) on the same chart. When they disagree on a criterion's answer, that disagreement is treated as a **discovery signal** for guideline ambiguity — not as a model-quality competition. A human methodologist adjudicates the underlying issue (is the rubric ambiguous? is one agent making an execution error? is this true clinical ambiguity?). Adjudications cluster into **proposals** that edit the rubric. The pilot iterates until disagreements stabilize and inter-rater agreement (Cohen's κ) hits a threshold.

- **Phase 2 — Lock.** The rubric is sealed at a specific git SHA. From this point on, the rubric is citeable and reproducible — methods sections cite the SHA, not "the latest version."

- **Phase 3 — Deployment + sample-based validation.** The locked rubric runs against a real cohort (10s to 10,000s of patients). A **stratified sample** (e.g., 50 patients, balanced agent-positive vs agent-negative) gets human-validated. The published accuracy number is the agent-vs-reviewer agreement on that sample, with a confidence interval — IRB-defensible external validation.

Three κ numbers appear in a publishable methods section, in order: **calibration κ ≥ lock-test κ ≥ deployment κ**. The gap between the first and the last is the load-bearing finding for reviewers ("does the rubric generalize?").

---

## How the platform supports this

The platform is a TypeScript/Node + React + Python codebase running locally against patient charts as files on disk. It has five surfaces a methodologist interacts with:

- **Studio (v2 React UI).** Where pilots, calibration, lock-test, and rule proposals live. The methodologist drives iterations from here.
- **Patient detail (the dual-agent layout).** When a pilot has N≥2 agents, this view shows the two drafts side-by-side per criterion with a 4-option adjudication form (guideline gap / Agent 1 error / Agent 2 error / true clinical ambiguity).
- **Disagreements summary tab.** Cross-cohort roll-up of where the agents disagreed, grouped by criterion.
- **Rules tab.** Pending rule proposals from the guideline-improvement pipeline; methodologist accepts or rejects each.
- **Audit / lock workflow.** Maturity state machine (draft → piloted → calibrated → locked) with full transition history.

Behind the surface:

- **Patients** live as folders of `.txt` clinical notes + `.json` OMOP-style structured data. No EHR integration in the MVP — patients are ingested as deidentified file bundles.
- **Guidelines** are YAML packages: `meta.yaml` + per-criterion files in `criteria/` + optional `keyword_sets/`, `code_sets/`, `edge_cases.yaml`, `exemplars/`. Versioned in git.
- **Agent runs** invoke a Claude Agent SDK `query()` with a chart-review skill that walks the agent through reading the chart, anchoring evidence quotes via a `find_quote_offsets` MCP tool, and committing structured answers via `set_field_assessment`. Outputs land as `runs/<run_id>/per_patient/<pid>/agents/<agent_id>.json`.
- **Adjudications** live as `pilots/iter_NNN/adjudications.json`. Methodologist's classification of each disagreement plus a suggested rubric edit when the issue is a guideline gap.
- **Proposals** are produced by a `guideline-improvement` agent that clusters adjudicated guideline-gaps into concrete YAML edits (`proposals/<task>/<id>.yaml`). Methodologist accepts/rejects each through the Rules tab.

---

## What this session produced

### Built (working code)

1. **Dual-agent disagreement-driven calibration MVP.** N-flexible run pipeline (any number of agents per pilot), per-agent role-prompt presets (default + skeptical), criterion-level disagreement extraction, 4-option adjudication queue, summary-tab roll-up by criterion. End-to-end working.

2. **Per-pilot model picker UI.** Each pilot can override the model on a per-agent basis without editing `.env`. Defaults to whatever's in `CHART_REVIEW_MODEL`; quick-pick chips for the common models.

3. **Skill-prompt fix for citation discipline.** A 30-line strengthening of the chart-review skill's evidence-citation requirement turned `claude-haiku-4.5` from a citation-skipper (32% coverage) into a fully-disciplined cite-everywhere agent (100% coverage) at no cost increase — actually faster and cheaper.

4. **6-model OpenRouter benchmark.** Ran the same chart on Qwen, DeepSeek (Pro + Flash), Google Gemini Flash, Claude Haiku 4.5, Claude Sonnet 4.6 with a structured 7-metric evaluation (cost, duration, completion, evidence density, faithfulness, ground-truth accuracy, stochastic stability). Surfaced a hidden behavioral failure mode (citation-skipping) that the original benchmark gates didn't catch.

The platform now produces **publishable artifacts end-to-end on a small calibration cohort** — drafts, disagreements, adjudications, and clustered rubric proposals — driven by a prompt-disciplined cheap model (`claude-haiku-4.5` at $0.23 per agent-run, 100% citation coverage, 100% citation faithfulness).

### Designed (specs ready to implement)

1. **Criterion-level rerun + carry-forward** (`docs/superpowers/specs/2026-05-03-criterion-level-rerun-design.md`). When the methodologist edits one criterion, only that criterion re-runs across the existing patients; drafts AND adjudications on unchanged criteria carry forward by `schema_hash` match. Cuts revision cost ~7×. Designed but not yet implemented; this is the next-priority build.

2. **Cohort + sample-based deployment validation** (`docs/superpowers/specs/2026-05-03-post-mvp-blueprint.md` §3–4). Locked-guideline runs against a real cohort, stratified sample of patients goes into a reviewer-validation queue, deployment-stage κ becomes the published accuracy number. Required before going to publication.

3. **Typed reliability dispatch** (`docs/superpowers/specs/2026-05-03-post-mvp-blueprint.md` §6). Today's κ-only metric only handles categorical answers. The platform should dispatch to the right metric per criterion type — weighted κ for ordinal, ICC + MAE + Bland-Altman for continuous, Jaccard for sets, date-aware metrics for dates, semantic similarity + spot-check for free text.

4. **Deployment-issue queue + triage UI** (`docs/superpowers/specs/2026-05-03-post-mvp-blueprint.md` §5). Production end-users flag wrong cases; methodologist triages (dismiss / agent error / data issue / guideline gap); guideline-gap issues cluster into a candidate next-pilot iter. Plus a small canary regression set for periodic model-version drift detection.

5. **Reproducibility bundle exporter.** Tarball of locked guideline + calibration runs (anonymized) + validation sample + agent role prompts + exact code commit. Required for IRB / methods-section reproducibility.

### Empirical findings worth remembering

- **`claude-haiku-4.5` with the strengthened skill prompt** is the recommended default: $0.23/agent-run, 100% citation coverage, 100% citation faithfulness, 88s wall clock, perfect inter-run κ stability.
- **`deepseek-v4-pro` is dominated by `claude-sonnet-4.6`** across every dimension we measured AND costs more in practice (despite cheaper per-token list price), because Anthropic's prompt-cache hits effectively through the Claude Agent SDK and OpenRouter routes for non-Anthropic models don't.
- **Citation-skipping is a model-discipline failure mode**, not a model-capability failure. The same model can be turned from skipper to discipline by ~30 lines of prompt amendment.
- **Schema changes invalidate carry-forward; prose changes don't.** This is the core insight behind the criterion-level rerun design — `schema_hash` per criterion governs portability of drafts and adjudications across iterations.
- **Statistical drift detection on small dev cohorts is statistical theater.** Use canary regression (small set of human-validated patients re-run on schedule) and reviewer-flagged issues instead.

---

## What it achieves, in one paragraph

The platform turns a chart-review study from "weeks of reviewer time + a tacit rubric + an irreproducible methods section" into a tracked iterative process: **draft a rubric, run two agents on a small calibration cohort, adjudicate the disagreements, accept the proposed rubric edits, lock the rubric at a specific git SHA, run it on the full cohort, sample-validate, publish** — with every step's artifacts (agent drafts, evidence citations, adjudications, proposals, accuracy metrics) on disk and version-controlled. The methods section a reviewer reads in the published paper points at a SHA they can clone, run, and reproduce. The agent does the cheap pattern-recognition work; the methodologist's time is spent on the ambiguous adjudications that *actually* refine the rubric. Cost per pilot iteration is around a dollar with the recommended model; per-patient deployment cost is around 25 cents.

The unsolved-but-designed work in the queue is what makes this story complete: criterion-level reruns to make revision cycles cheap, cohort+sample validation to produce the publishable accuracy number, typed reliability metrics to handle non-categorical criteria, and a deployment-issue loop to keep the rubric improving once it's in production.

---

## Where to look in the repo

- **`docs/superpowers/specs/`** — design documents in date order. The `2026-05-03-post-mvp-blueprint.md` is the consolidated reference for everything after the MVP.
- **`docs/superpowers/plans/`** — implementation plans for executed work.
- **`guidelines/lung-cancer-phenotype/`** — the reference guideline used in calibration. `criteria/` has the per-criterion YAML files; `pilots/iter_NNN/` are the iteration histories.
- **`corpus/patients/`** — the deidentified test patients. `meta.json` + `notes/` + `omop/` + `ground_truth.json` per patient.
- **`runs/<run_id>/`** — per-iteration agent invocations (gitignored — ephemeral; stored on disk for inspection).
- **`reviews/<patient_id>/<task_id>/`** — per-patient review state (gitignored — runtime data).
- **`proposals/<task>/`** — pending and accepted rubric edits.
- **`app/server/`** — Node/TypeScript API + agent-invocation runtime.
- **`app/client/src/`** — React 18 + Tailwind + Radix UI front end.
- **`.claude/skills/chart-review/SKILL.md`** — the prompt that drives the agent's chart-review behavior. The most-edited file in the repo, and the most important one for behavior tuning.

---

*The platform is at a point where one more concentrated build sprint (criterion-level rerun + cohort validation workflow) makes it ready for a real publication-track study. Until then it's a methodologically sound prototype on a 5-patient calibration corpus.*
