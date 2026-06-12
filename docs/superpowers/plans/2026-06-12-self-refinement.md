# Increment — Automatic rubric self-refinement (phenotype first)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Compare **model output vs human annotation** and propose rubric
improvements automatically — but as **transparent, human-applied** proposals, and
only edits that **demonstrably generalize** (improve held-out agreement). This is
the platform's "rubric tightens until κ stabilizes" loop, made automatic +
measured + reviewable.

**Why now / why not v2's:** v2 has `/api/guideline-improvement`
(`domain-proposal/improveGuideline`) but it's an OPEN loop — no held-out
validation, no judge-attribution filter (the guideline_gap-vs-agent_error signal
is explicitly deferred in v2), no anti-leakage guard, opaque YAML proposals. So
it can't tell a generalizable fix from memorizing the seen cases, and a human
can't easily review what/why. concur stripped it entirely → clean-slate build of
the *measured, transparent* version. The inputs it needs — the **judge**
(`classification_hint` attribution) and **performance/calibration** (κ/F1) — were
just built in concur.

## Locked decisions (2026-06-12)
- **Phenotype first** (rubric-edit routes `GET /rubric`, `PUT /criteria/:fieldId`,
  `PUT /overview` + the editable RubricPanel + AUTHOR phase all exist; NER/adherence later).
- **Human applies transparent cards** (not auto-apply).
- **Spike the held-out re-score cost** on one cluster before choosing
  affected-units-only vs full-rerun.

## The proposal artifact (centerpiece — must be human-legible)
Each proposal is a card, NOT a diff. Four sections:
- **① What was wrong** — the specific cases where agent output ≠ the reviewer's
  validated answer: patient, note excerpt + offsets, `agent → X / you → Y`.
- **② Why** — the rubric gap (what the criterion fails to say).
- **③ Rule to add** — the exact generalizable text to append to the criterion
  (a rule/clarification, never "patient X → answer Y").
- **④ Does it help** — held-out κ/F1 delta after applying the rule to a candidate
  rubric and re-scoring held-out patients (+ "N regressed").
Plus `[Apply] [Edit] [Reject]`. On Apply: a versioned, revertable rubric edit
with the card archived as provenance.

## The careful loop (safeguards)
1. **Attribute first:** keep only disagreements the judge tags `guideline_gap` /
   `true_ambiguity`; NEVER refine on `agent_error` (don't fix the rubric for the
   model's mistakes).
2. **Held-out validation:** split validated patients into refine-set (proposer
   sees) vs held-out (never seen); keep an edit only if held-out agreement
   improves beyond a margin.
3. **Generalize, don't memorize:** propose rule clarifications; leakage-scan
   rejects patient-ids / verbatim gold values.
4. **Closed loop:** propose → candidate-apply → measure held-out → accept/reject;
   loop until no proposal improves held-out for K rounds; cap edits/round.
5. **Human gate + provenance:** the human applies each card; every apply is
   versioned/revertable with the card as the recorded reason.

**Reference (v2, for the prompt/skill shape only — NOT the open-loop mechanics):**
`packages/domain-proposal/src/guideline-improvement.ts`, the `chart-review-improve`
skill. **Concur reuse:** judge (`server/lib/judge.ts` `classification_hint`,
`judge_analyses.json`), performance (`server/performance-routes.ts` `computePerformance`),
review state (validated `field_assessments` source=reviewer), rubric edit routes
(`server/rubric-routes.ts`), AUTHOR phase + RubricPanel.

---

## Task S1: Attribution + clustering (read-only)

**Files:** new `server/lib/refine/candidates.ts` (pure-ish) + a GET route.

- [ ] **Build the agent-vs-human disagreement set** for a validated iter: for each patient whose session review_state is `reviewer_validated`, for each leaf criterion, compare the **agent's draft answer** (`var/runs/<run>/per_patient/<pid>/agents/<aid>.json` field_assessments — most-recent run in the iter's chain, like `computePerformance` does) to the **reviewer's validated answer** (`field_assessments` with `source==="reviewer"`). A mismatch = a disagreement. Capture the evidence: the reviewer's cited note excerpt + offsets, agent answer, reviewer answer.
- [ ] **Attribute** each disagreement: join the judge's `classification_hint` from `judge_analyses.json` for that (patient, criterion) cell where present (reuse the judge output). If a cell wasn't judged, mark `attribution: "unjudged"`. **Filter to `guideline_gap` + `true_ambiguity`** for refinement (exclude `agent_error`; surface `unjudged` separately so the user can run the judge first).
- [ ] **Cluster by criterion** (`field_id`): each cluster = `{ field_id, criterion_def, examples: [{patient_id, note_id, excerpt, offsets, agent_answer, reviewer_answer, judge_reasoning, classification_hint}], n_guideline_gap, n_agent_error, n_unjudged }`. This is the ① data of the proposal card.
- [ ] **Route:** `GET /api/refine/:taskId/:iterId/candidates?session_id=` → `{ clusters: [...], n_validated_patients, n_held_out_reserved? }`. Gate on phenotype task_kind (NER/adherence later). Session-scoped.
- [ ] typecheck → 0. Verify live: on a validated phenotype iter (create one if needed — run cancer-diagnosis, validate with a deliberate agent-vs-reviewer disagreement, judge it), the endpoint returns the clustered wrong-examples with attribution. **Commit** `feat(concur): self-refine S1 — attributed agent-vs-human disagreement clustering`.

## Task S2: Refiner → transparent proposal card (②③)

**Files:** new `server/lib/refine/propose.ts` + route; client proposal card.

- [ ] **Refiner LLM** (reuse the judge's runAgent/model plumbing): input = the criterion's current definition + the cluster's wrong examples (note excerpts + agent/reviewer answers + judge reasoning). Output (strict schema): `{ gap_summary (②), proposed_rule_text (③, the exact clarification to append), rationale }`. Prompt it to write a GENERALIZABLE rule (decision criteria / edge-case handling), explicitly NOT instance memorization. Inline the schema (deepagents doesn't auto-load skills — same lesson as the judge).
- [ ] **Leakage scan:** reject/flag a `proposed_rule_text` that contains a patient_id or a verbatim long gold value (basic guard against memorization). 
- [ ] **Route:** `POST /api/refine/:taskId/:iterId/propose?session_id=` `{field_id}` → the card data (①②③, no ④ yet). 
- [ ] **Client:** a proposal card component rendering ①②③ + `[Apply]` (calls the existing `PUT /criteria/:fieldId` to append `proposed_rule_text` to the criterion definition/extraction_guidance) + `[Edit]` + `[Reject]`. Surface it in the AUTHOR (or DECIDE/Performance) phase. typecheck + build.
- [ ] **Commit** `feat(concur): self-refine S2 — transparent rubric-edit proposal cards`.

## Task S3: Held-out validation (④) — the careful core

**Files:** `server/lib/refine/holdout.ts` + extend the propose route.

- [ ] **Split:** deterministically partition the validated patients into refine-set + held-out (e.g. by patient_id hash; configurable fraction; refuse/disclaim if too few held-out for a meaningful κ). The refiner (S2) sees ONLY refine-set examples.
- [ ] **Candidate-apply + re-score:** apply `proposed_rule_text` to a CANDIDATE rubric copy (do NOT touch the live rubric), re-score the held-out patients' agreement (κ/F1 via the performance computation), and the refine-set, → `Δκ_heldout`, `n_regressed`. **SPIKE the cost here**: start with re-scoring only the affected criterion on held-out (cheapest); measure; decide whether full-rerun is needed. Re-scoring may require re-running the agent on held-out under the candidate rubric — prototype on ONE cluster, measure LLM cost/time, then generalize.
- [ ] Attach ④ to the card; sort/gate proposals by `Δκ_heldout` (show "no measurable improvement" when ≤ margin rather than applying blindly).
- [ ] **Commit** `feat(concur): self-refine S3 — held-out validation of proposals (Δκ)`.

## Task S4: Loop + provenance

- [ ] **Loop-until-dry** across clusters: generate + held-out-validate proposals for all `guideline_gap` clusters; iterate rounds until none improves held-out (cap rounds + edits/round). Each round re-judges/re-scores. (Human still applies per card; this just keeps surfacing the next best proposal.)
- [ ] **Provenance:** each Apply records the card (the wrong examples + rule + Δκ) alongside the rubric edit; versioned + revertable. Surface "this rule was added to fix these N cases (+Δκ)" in the criterion's history.
- [ ] e2e: a full cycle on cancer-diagnosis — deliberate rubric-gap disagreement → judge → candidate card with ①②③④ → apply → re-run shows agreement up. **Commit** `feat(concur): self-refine S4 — loop + applied-edit provenance`.

## Self-review
- Only `guideline_gap`/`true_ambiguity` feed refinement (never `agent_error`).
- Held-out Δκ gates every edit (the v2 gap).
- Proposals are human-legible cards (wrong example + rule-against-failure + proof) and human-applied.
- Generalization/leakage guard; versioned/revertable applies with provenance.
- Phenotype first; reuses judge + performance + rubric routes.
- One commit per task; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; no --no-verify.
