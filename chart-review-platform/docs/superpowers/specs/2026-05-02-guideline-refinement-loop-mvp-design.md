# Guideline Refinement Loop — MVP Design

**Date:** 2026-05-02
**Status:** Spec, awaiting user review
**Scope:** The stage *between* a drafted guideline and a locked, publishable guideline.
**Non-goals (MVP):** dual-blind human-vs-human κ gate, multi-reviewer adjudication UI, internal-validation tripwire set, anchor/rotating dev split, staged lock expansion, per-iter live dashboard. All deferred; see *Future extensions*.

## 1. Problem

A drafted guideline (`guidelines/drafts/<id>/`) is not yet operationally clear. Reviewers and the chart-review agent both make mistakes against it. We need a structured loop that (a) iteratively tightens the guideline using real disagreements, (b) reports per-criterion agent performance, and (c) ends with a locked guideline whose performance is documented.

## 2. Goals

1. **Revisable** — each iteration produces concrete proposals; the methodologist accepts/edits/rejects them and a new guideline version is materialized.
2. **Performance reported** — every iteration emits a per-criterion accuracy table; the lock test emits a final report against a held-out cohort.
3. **Cheap to operate** — single human oracle by default; reuses three existing skills (`chart-review`, `review-copilot`, `guideline-improvement`); minimal new code.

## 3. Architecture

### 3.0 UI placement (Studio → Pilots tab — extend, don't add)

The platform v2 shell (`app/client/src/v2/AppShell.tsx`) already has top-level routes `Queue · Patient · Studio · Audit · Help`, and `Studio.tsx` already has tabs `Pilots · Calibration · Rules · Methods · Bundles · Authoring`. The MVP refinement loop **extends the existing Studio → Pilots tab** rather than adding a new section.

Entry-point chain (existing where noted):

```
Studio › Authoring   →  user generates draft via AuthoringWizard
                          ↓ "Promote to pilot" button (existing API: /api/authoring/promote/:taskId)
Studio › Pilots      →  iteration timeline (FigurePage), iter rows, MVP additions below
                          ↓ click iter row
                          → iter detail: per-criterion accuracy, validation progress, override clusters, proposals
                          ↓ "Request lock test" (enabled when eligibility met)
                          → lock-test iter (visually distinct row, pinned to LOCK cohort, pass/fail outcome)
```

What `PilotsFigure` shows today (per `Studio.tsx`):
- Stats: Iterations, Proposals (total), Auto-critique state
- Iter list with hero number, iter_id, state badge, completion count, started_at, proposal count

MVP additions:
| Surface | Today | MVP delta |
|---|---|---|
| Iter row | state + proposal count | + per-criterion accuracy mini-strip (worst-criterion accuracy badge) + "ready for lock test" eligibility flag |
| Iter row click | (none in v2 — empty state says "v2 wiring lands next phase") | opens iter detail panel: per-criterion accuracy table, validation progress per patient, override clusters, proposal links |
| Top of figure | empty state copy | "Start iter N" action (only when no in-progress iter); also surfaces eligibility for lock test |
| Lock-test iter | (does not exist as a distinct visual) | dedicated row variant: pinned LOCK cohort, copilot blind-mode required, pass/fail verdict + lock-report download |

The visual idiom is fixed by existing code: research-paper figures (Fraunces display @ SOFT 50–60, IBM Plex body 14/1.5, mono 12.5, oxblood active accent, cream paper background, hairline rules, tabular hero numbers, tracked-out caps for headings). New Pilots additions must match.

### 3.1 Cohorts

Two frozen patient sets, defined once at iter 0 in a new `sampling.json` inside the guideline package:

```json
{
  "dev_patient_ids": ["pid_001", ..., "pid_010"],
  "lock_patient_ids": ["pid_101", ..., "pid_130"],
  "stratification_notes": "≥1 positive, ≥1 negative, ≥1 edge per primary criterion"
}
```

- **DEV (10 patients)** — used every iteration for refinement.
- **LOCK (30 patients)** — frozen at iter 0; the agent and authoring loop **never run on lock patients during dev iterations.** Used once, at the end, for the lock test.

The data shape supports `>=2` reviewers per patient (multi-oracle is a future extension), but MVP requires exactly one oracle.

### 3.2 Agent roles (already wired)

| Role | Skill | Commits answers? |
|---|---|---|
| Annotator | `chart-review` | yes |
| Copilot | `review-copilot` | no, read-only |
| Critic | `guideline-improvement` | no, writes proposals |

The methodologist owns the *only* path that edits the guideline (manual revise after reviewing proposals).

### 3.3 Maturity transitions

The MVP loop drives these existing FSM transitions in `guidelines/<id>/maturity.json`:

```
draft ──► piloted ──► (loop) ──► piloted ──► … ──► locked
                                               (lock test passes)
                                               
locked ──► piloted (unlock for revision; existing flow)
```

`calibrated` is reused as a *pre-lock* state when the methodologist signs off but the lock test has not been run. `calibrated → locked` requires lock-test pass.

## 4. The iteration loop

```
iter n (with frozen dev cohort and current guideline v_n):

  1. AGENT pass
     chart-review skill runs against every dev patient.
     Writes review_state.json with answer + evidence + rationale.

  2. ORACLE validation (with copilot)
     Oracle opens each dev patient, sees agent draft, uses
     review-copilot to ask "why this answer?", "show evidence
     against", etc. Overrides where wrong. Each override captures
     edit_reason, edit_note, and original_agent_snapshot.

  3. METRICS
     Per-criterion accuracy on dev cohort = (count where
     final_answer == agent_answer) / (count of evaluable
     assessments). Stored in pilots/iter_NNN/critique.json.
     Per-iter markdown report at pilots/iter_NNN/report.md.

  4. CRITIC
     guideline-improvement skill ingests overrides, clusters by
     criterion / edit_reason / evidence pattern, writes
     proposals to proposals/<guideline-id>/.

  5. MANUAL REVISE
     Methodologist reviews proposals, applies (or rejects) edits
     to the guideline package. Bumps to v_{n+1}; new
     guideline_sha is recorded in pilots/iter_{n+1}/manifest.json.
```

## 5. Stopping criteria (lock-eligible)

**Definitions (MVP):**
- *Primary criterion* — every criterion in `criteria/*.yaml` whose answer is reviewer-emitted (i.e., not a derived field with a `derivation` expression). Reported separately from derived fields, which are mechanical.
- *Per-criterion accuracy* — over patients where the criterion is *evaluable*, i.e., its `is_applicable_when` gate is satisfied per the oracle's answers. For non-gated criteria, denominator = full cohort size.
- *Override rate* — total overrides / total reviewer assessments across all primary criteria for the iteration.

The dev loop is *eligible* for lock test when, **for two consecutive iterations**:

- Every primary criterion has dev accuracy ≥ 0.9, **and**
- No new override clusters were introduced (proposal queue stable), **and**
- Override rate has not increased.

Eligibility doesn't auto-trigger the lock test; the methodologist explicitly initiates it. (This is the existing `piloted → calibrated` PI-signoff transition.)

## 6. Lock test (the gate)

Run once when methodologist signs off:

1. Agent runs `chart-review` against every lock patient with the *frozen* current guideline.
2. Oracle annotates every lock patient. **Copilot allowed in retrieve / explain-rule modes; *not* in explain-agent-rationale mode** to keep the oracle from anchoring on the agent's draft. (MVP: enforced by convention; a `blind_mode` copilot flag is a near-term follow-up.)
3. Compute per-criterion accuracy on the lock cohort.
4. **Pass** if every primary criterion has point-estimate accuracy ≥ 0.9 → maturity transitions `calibrated → locked`. Lock report written to `lock_test/<guideline-id>/<run-id>/report.md`.
5. **Fail** otherwise → identify failing criterion(s); add stratified dev patients of that pattern type to `sampling.dev_patient_ids`; resume loop. Maturity rolls back `calibrated → piloted` (the methodologist must sign off again before the next lock attempt). The lock cohort is **not** modified — same 30 patients are reused for the next lock attempt; rerunning against the same lock set after rubric edits is acceptable in MVP because the lock cohort is small and the alternative (refreshing it each attempt) is more expensive than the bias risk it controls.

## 7. Reports

Two markdown shapes, both per-iteration-or-test:

### 7.1 Per-iter report (`pilots/iter_NNN/report.md`)

```markdown
# Iter NNN — guideline-id @ guideline_sha

## Per-criterion accuracy (DEV, n=10)
| criterion                    | n  | accuracy | Δ vs prior iter |
|------------------------------|----|----------|-----------------|
| pathology_lung_primary       | 10 | 0.80     | +0.10           |
| icd_lung_cancer_present      | 10 | 0.90     | 0.00            |
| ...                          |    |          |                 |

## Overrides
- total: 6
- by edit_reason: misinterpreted=3, missed_evidence=2, criterion_ambiguous=1

## Top unresolved override clusters
1. carcinoid pathology mis-classified as nsclc (3 patients)
2. ...

## Proposals emitted this iter
- prop-abc123: edge_case_add for carcinoid → pathology_lung_primary
- prop-def456: keyword_set extension for "neuroendocrine"

## Eligibility for lock test: NO (1 of 2 consecutive iters meeting threshold)
```

### 7.2 Lock report (`lock_test/<guideline-id>/<run-id>/report.md`)

Same per-criterion table on the lock cohort (n=30), plus a methods-paper-ready summary block (sample size, oracle id, copilot mode, version pedigree, transition timestamp). Becomes the input artifact for the existing `methods-section-drafting` skill.

## 8. New code (the small surface)

1. **`sampling.json` schema and reader** in the guideline package.
2. **Per-iter accuracy computer** (utility): walks `reviews/<patient>/<guideline-id>/review_state.json` for the dev cohort, compares `original_agent_snapshot` to final answer per field, emits the per-criterion table. Writes both `pilots/iter_NNN/critique.json` (machine) and `pilots/iter_NNN/report.md` (human).
3. **Lock-test runner**: same computation against the lock cohort; gates the maturity transition.
4. **Lock-test report writer**: `lock_test/<guideline-id>/<run-id>/report.md`.

Everything else (pilot iteration scaffolding, override capture in `review_state.json`, `guideline-improvement`'s clustering, maturity FSM, manifest tracking) already exists.

## 9. Acknowledged limitations

- **N=30 lock set gives a 95% CI lower bound around 0.74 at observed 0.9.** Adequate for "the agent works"; **not** publication-grade. Acknowledged in the lock report's limitations section. When publishing, expand the lock cohort and re-run with a CI-lower-bound gate (future extension).
- **Single oracle accuracy can't separate guideline ambiguity from agent error.** A high-accuracy run could still hide rubric ambiguity that would surface with a second human. Future extension: dual-blind κ gate.
- **Dev overfit is only caught by the lock test.** No mid-loop tripwire; if dev passes and lock fails, the loop redoes with fresh patients, costing extra oracle hours.
- **Anchoring during dev validation** — oracle sees agent draft before annotating. Real but second-order; addressed later via a blind-first subset.
- **Copilot blind mode for the lock test is convention-enforced in MVP.** A platform-level `blind_mode: true` flag is a near-term follow-up before the first publishable lock test.
- **Lock-cohort reuse across retries.** If lock test 1 fails and we retry against the same 30 patients, those patients have effectively been seen during failure analysis even if the rubric isn't tuned to them directly. Bias risk is bounded but real. Acceptable for MVP because the alternative (fresh lock cohort per retry) is expensive; future extension can reserve a tertiary "final" lock set used at most once.

## 10. Future extensions (roadmap, not MVP)

| Extension | Trigger | Notes |
|---|---|---|
| Multi-reviewer + κ gate | a guideline targeting publication | Requires two humans on the lock cohort once; extends `guideline-calibration` (already drafted as a skill) |
| Lock cohort expansion to N≥50 with CI lower-bound gate | publication | Re-run lock test on expanded cohort; same code path |
| Internal validation set (15) as overfit tripwire | repeated lock failures | Cheap; oracle annotates once |
| Anchor + rotating dev split | dev set memorization observed | Adds rotation to `sampling.json` |
| 20% blind-first dev subset | anchoring shown to bias accuracy upward | Adds a `blind_first` flag in iter manifest |
| `blind_mode` copilot flag | first publishable lock test | Platform-side enforcement of mode restriction |
| Per-iter live dashboard | methodologist demand for daily workflow | UI work; reports already exist file-shaped |

## 11. Operational checklist (one-page TL;DR)

1. Curate `sampling.json` (10 dev + 30 lock, stratified).
2. Run iter 1: agent → oracle+copilot → metrics → critic → manual revise.
3. Repeat until two consecutive iters meet threshold.
4. PI signs off (`piloted → calibrated`).
5. Run lock test (agent on lock, oracle on lock, compute table).
6. If pass: `calibrated → locked`. Lock report written. Done.
7. If fail: identify failing criterion, add stratified patients to dev, resume from step 2.
