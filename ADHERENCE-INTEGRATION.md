# Adherence task — implementation plan

Source: `2026-03-Agentic-Asthma-Adherence-Design.pdf`.
Pattern: third `task_kind` alongside `phenotype` and `ner`. Hand-authored
questions + rules in phases 0-3; PDF-ingestion mode deferred to phase 4.

## Phase 0 · Foundation (3-5 days)

| Step | Files | Notes |
|---|---|---|
| 0.1 | `packages/platform-types/src/index.ts` | Add `QuestionAnswer`, `RuleVerdict`, `AttributionCategory` types; `task_kind: "adherence"` discriminator |
| 0.2 | `packages/tasks/src/index.ts` | `taskKindFromTaskType` maps `adherence` → kind |
| 0.3 | `packages/domain-review/src/review-state.ts` | Extend ReviewState with `question_answers?: QuestionAnswer[]`, `rule_verdicts?: RuleVerdict[]` |
| 0.4 | `packages/storage/src/index.ts` | Path helpers if needed (most paths are shared) |
| 0.5 | `server/run-routes.ts` | task_kind dispatcher — return 501 placeholder for adherence |

**DoD**: typecheck clean. `POST /api/runs` with adherence task returns 501.

## Phase 1 · Pipeline core (5-7 days)

| Step | Files | Notes |
|---|---|---|
| 1.1 | `packages/pipeline-extract-adherence/` (new) | Direct-LLM 3-pass: retriever + extractor + rule-eval. Mirror `pipeline-extract-ner`'s direct-LLM shape — no agent loop, server-side orchestration |
| 1.2 | `packages/rule-engine/` (new) | Deterministic rule DSL — operates on `QuestionAnswer[]`, emits `RuleVerdict`. Subset of language: if/else, refs to question_ids, comparisons. LLM-as-judge only when rule has `nuanced: true` |
| 1.3 | `packages/infra-batch-run/src/runs.ts` | `task_kind === "adherence"` branch — call pipeline-extract-adherence per patient (NOT per note — patient-level reasoning) |
| 1.4 | Patient context store | In-memory accumulator passed across tiers — earlier-tier answers feed later-tier prompts as structured JSON, not raw notes |

**DoD**: one patient end-to-end produces `review_state.json` with answers + verdicts. Cost ≤ $0.20/patient on a 7-question framework.

## Phase 2 · Skill format + reference task (4-5 days)

| Step | Files | Notes |
|---|---|---|
| 2.1 | `.agents/skills/chart-review-asthma-adherence/` | First concrete adherence task. Authored manually from PDF examples, no guideline-ingestion mode yet |
| 2.2 | `references/questions/*.yaml` | One file per tier (T0 eligibility, T1 control assessment, T2 management). Each question: id, text, answer_schema, tier, depends_on, retrieval_hints |
| 2.3 | `references/rules/*.yaml` | One file per concordance rule. Refs question_ids; specifies `verdict_if` boolean expr + attribution mapping |
| 2.4 | `references/attribution.yaml` | Enum: `DOCUMENTATION_GAP`, `GUIDELINE_DEVIATION`, `PATIENT_REFUSAL`, etc. |
| 2.5 | `packages/eval-adherence-iaa/` (new) | F1 per question, κ per rule between agent and reviewer |

**DoD**: smoke run on 1 synthetic asthma patient → 7 questions answered + 3 rules evaluated.

## Phase 3 · Studio UI (7-10 days)

| Step | Files | Notes |
|---|---|---|
| 3.1 | `client/src/ui/Workspace/PhaseAdherenceAuthor.tsx` | Two-pane editor: Questions (one card per question, tier badge) + Rules (one card per rule with the boolean expr) |
| 3.2 | `client/src/ui/AdherenceReview.tsx` | Per-patient: question list with answers + reviewer accept/override; rule verdict table with attribution editor |
| 3.3 | `Workspace/index.tsx` | task_kind dispatch: AdherenceReview when adherence, SpanReview when ner, PatientReview when phenotype |
| 3.4 | `PhaseValidate.tsx` / `PhaseDecide.tsx` | task_kind branch — counters use "questions validated" + "rules adjudicated" |
| 3.5 | `PhaseLock.tsx` | F1/κ calibration card adapts to per-question + per-rule metrics |

**DoD**: methodologist can do every adherence lifecycle step through the Studio.

## Phase 4 · Guideline ingestion mode (deferred, 1-2 weeks)

Optional. `chart-review-adherence-author` skill ingests a guideline PDF and proposes a question framework via active-learning refinement loop. Heavy NLP / human-in-the-loop scope. Skip until manual-authoring works end-to-end and 2-3 hand-authored tasks exist as reference.

---

## Reusable, no new code

- TRY phase + pilot iter machinery
- DECIDE / LOCK skeletons
- Bundle export (with one schema change to include rules + verdicts)
- Maturity transitions (draft → piloted → calibrated → locked)
- Audit trail + transcript persistence
- Improve flow (clusters per-question + per-rule disagreements)

## Risks

1. **Rule DSL scope** — start tiny (boolean over question answers). Don't reinvent guideline ontologies.
2. **Tier dependencies** — agent must skip later tiers if T0 excludes patient. Implement as server-side gate, not agent reasoning.
3. **Question framework authoring is the bottleneck** — for the first task, hand-author from the PDF. Defer ingestion mode until 2-3 hand-authored tasks exist and you know what's hard.

## Cost target

Per-patient: 3-5 LLM calls total, mostly cached prefix.
**~$0.05-$0.15 per patient** regardless of question count or note volume.

## Phasing total

Phases 0-3: **~3-4 weeks**. Ships end-to-end asthma-adherence task. Subsequent adherence tasks (NCCN lung cancer, ADA diabetes) reuse the entire pipeline; only the questions+rules YAMLs change.
