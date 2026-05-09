# Agent-enhanced chart review — MVP scope and deferred work

**Date:** 2026-05-02
**Status:** Decided in /grill-me session; awaiting implementation plan
**Source spec:** the full "Complete Design Spec: Agent-Enhanced Chart Review for Guideline Calibration" pasted into the grilling session
**Predecessor specs:**
- `2026-05-02-guideline-refinement-loop-mvp-design.md` — current single-agent + reviewer-override pipeline that this MVP layers onto

This document records what we are committing to build as MVP, what we are explicitly NOT building yet, and the rationale for each deferral. Future sessions should be able to pick up the deferred items with full context for *why* they were deferred and *under what conditions* to un-defer them.

---

## MVP framing

The MVP is the **next increment on the existing chart-review platform**, not a from-scratch build of the full design spec. The existing single-agent + reviewer-override pipeline stays. Dual-agent disagreement is added as a calibration mode that subsumes the single-agent flow when N=1.

### Job-to-be-done dual-agent is hired for

**Primary:** guideline-ambiguity detection. When two agents read the same chart and the same guideline and reach different conclusions, that disagreement is treated as a discovery signal for guideline gaps (per spec §3.3).

**Secondary:** anti-anchoring during reviewer adjudication. Two competing drafts force the reviewer to consider alternatives instead of confirming a single agent's reading. Falls out for free as a UX side-effect of the side-by-side adjudication surface.

### Validating signal before committing

A "fake dual-agent" test on `patient_probable_fhx_01` (run via close reading, not infrastructure) demonstrated that the methodology produces real signal. The dominant disagreement on that case was a `yes` vs `no_info` mismatch on `oncologist_lung_cancer_diagnosis_in_note`, exposing a genuine guideline gap: the criterion's `guidance_prose` collapses three clinically distinct situations ("rule-out," "working diagnosis pending tissue," "true uncertainty") into "doesn't qualify." Both agents were reading the guideline correctly; they resolved the ambiguity differently. That is the kind of gap dual-agent should surface, and it would not have surfaced from the existing single-agent + override pipeline.

---

## MVP scope (what we are building)

### M1 — N-flexible run pipeline

Pilots configure `N ≥ 1` agents via an `agent_specs[]` array on the pilot manifest. Each spec has `{ id, role_preset, role_version, role_prompt?, model }`. The run pipeline starts N parallel agent invocations from that array. Outputs land at `runs/<run_id>/per_patient/<pid>/agents/<agent_id>.json`.

Backwards compatibility: existing manifests without `agent_specs` are read as `agent_specs: [{ id: "agent_1", role_preset: "default", ... }]` (implicit N=1).

**Code shape:** `agent_specs[]` is added to the pilot manifest schema in `app/server/pilots.ts`; `runs.ts` loops over the array instead of running a single agent.

### M2 — Disagreement extraction

A new step, run on pilot completion (or on demand), that compares all `(agent_i, agent_j)` pairs at the criterion level and emits `pilots/iter_NNN/disagreements.json`.

**Disagreement detection rules (decided in Q8):**
- Hard mismatch (`yes` vs `no`) — flag.
- Soft mismatch (`yes` vs `no_info`, `no` vs `no_info`) — flag. The dominant guideline-gap signal in the fake-dual test was exactly a soft mismatch.
- Same answer, different cited evidence — track count for metrics, do **not** queue for adjudication. Rationale below in "Deferred."
- Same answer, same evidence — no output.

**Counts also emitted as metrics:** total disagreements per criterion, soft-vs-hard split, same-answer-different-evidence count per criterion. These feed cross-pilot drift analysis later.

### M3 — Reviewer adjudication UI

Two layouts, switched by N on the pilot manifest:
- **N=1:** existing single-draft override layout. Zero change.
- **N=2:** new two-column side-by-side disagreement adjudication layout. Reviewer sees both drafts per criterion, plus the disagreement queue ordered by criterion or severity. For each disagreement, reviewer picks one of four options (decided in Q7):

  1. **Guideline gap** — guideline didn't tell the agents how to handle this. Suggested revision text required. Routes to `proposals/<id>.yaml`.
  2. **Agent 1 error** — guideline was clear; agent 1 misapplied it. Routes to `agent_errors.json`.
  3. **Agent 2 error** — guideline was clear; agent 2 misapplied it. Routes to `agent_errors.json`.
  4. **True clinical ambiguity** — chart genuinely doesn't support a clear answer. Routes to `adjudications.json` only (no proposal, no error backlog entry).

  Anonymization: UI labels are "Agent 1" / "Agent 2", not "Default" / "Skeptical". Role labels stay in run metadata for debugging/cohort-feedback but are not surfaced in the adjudication surface (anti-anchoring decision in Q4).
- **N≥3:** falls back to N=2 layout with a pair-chooser. Adequate for experimentation, not a real ensemble UI. Voting / consensus visualization is deferred (see "Deferred" below).

**The bulk of MVP frontend work lives in M3.** Existing components (`AdjudicationLayout`, `ReviewForm`, `CriterionPane`, `SelectedEvidencePanel`) are built around the single-draft override model. M3 either forks them for the N=2 layout or generalizes them.

### Default agent configuration

When starting a new pilot, default config is `N=2` with role presets `[default, skeptical]`. Reviewer can change before clicking Start.

**Role presets (shipped in MVP):**
- `default` — *"You are a careful chart reviewer. Apply the guideline as written. When evidence is hedged, default to the most natural clinical reading. Cite specific quotes for each criterion."*
- `skeptical` — *"You are a strict chart reviewer. Apply the guideline literally. When language is hedged, qualified, or pending, prefer the more conservative answer (`no_info` over `yes`; `no` over `yes`). When the guideline is silent on a case, prefer the answer that requires less inference. Cite specific quotes for each criterion."*

Stored in repo at `prompts/agent_roles/<preset>.md`, versioned.

**Periodic noise-floor check:** every Nth pilot (or on demand), run with `[default, default]` (same prompt twice). Disagreement rate from that run = stochastic floor. If a `[default, skeptical]` pilot produces disagreement rate similar to the noise floor, the methodology isn't producing useful signal on that guideline.

### Outputs

Per pilot iteration with N≥2:
- `pilots/iter_NNN/manifest.json` — extended with `agent_specs[]`.
- `pilots/iter_NNN/disagreements.json` — raw pairwise disagreement records.
- `pilots/iter_NNN/adjudications.json` — reviewer's structured decisions. Source-of-truth audit log.
- `pilots/iter_NNN/agent_errors.json` — adjudications classified as agent error. Used in Phase 2 (agent execution optimization). For MVP, just a flat list — no clustering yet.
- `proposals/<guideline-id>/<id>.yaml` — adjudications classified as guideline gap, run through the existing `improveGuideline` clustering. Output schema unchanged from today.

The existing `proposals/` UI and accept/reject workflow do not change. Only the source of clusterable disagreement signal changes.

---

## Deferred items (post-MVP) and rationale

### Evidence-item-level role/status/strength taxonomy (spec §8.2, §13.6)

**Why deferred:** without it, criterion-level disagreement is the highest-value signal we can extract. Adding evidence-item-level structured outputs is a substantial agent-prompt + data-model + UI build that doesn't pay off until the criterion-level signal is exhausted. Most guideline gaps surface at the criterion-outcome level (per the fake-dual test).

**Trigger to un-defer:** when N≥3 pilots have run dual-agent and the criterion-level disagreement queue is no longer surfacing new guideline gaps (saturation), but reviewers report that the agreed-on-criterion cases still feel "off." That's the signal that hidden disagreement is what's left.

### Same-answer-different-evidence in the adjudication queue

**Why deferred:** four scenarios collapse into "same answer, different evidence":

1. **Multiple valid evidence paths** — chart has equally-good evidence in multiple places; agents pick different ones. Not a guideline problem.
2. **Different sufficiency bars, same outcome** — Agent 1 cited a definitive statement, Agent 2 cited a weak proxy. Both said `yes`. **Guideline problem** — the guideline didn't say which evidence type is preferred or that the weak proxy alone is sufficient.
3. **One agent missed evidence** — Agent 1 found a smoking-gun quote, Agent 2 missed it and built up to the same answer through weaker proxies. Agent execution problem (Phase 2), not guideline.
4. **Chart redundancy** — multiple ambiguous mentions, agents pick different ones, both happen to converge. Not a guideline problem.

Distinguishing #2 (the only one we care about) from #1/#3/#4 requires evidence-strength classification — i.e., the evidence-item-level taxonomy above. Without that, "different evidence cited" is mostly noise, and queueing those cases mostly wastes reviewer time on #1/#3/#4.

**For MVP:** track the count per criterion as a metric ("17 agreed-but-on-different-things on `oncologist_diagnosis_in_note`"). The count alone is a useful signal — if a criterion has lots of these, that's a flag to revisit later — but don't put them in the adjudication queue.

**Trigger to un-defer:** at the same time as evidence-item-level taxonomy. Then the system can filter to case #2 cleanly (agents agreed on outcome but cited different *classes* of evidence under the new taxonomy).

### Real N≥3 disagreement UI with voting / consensus

**Why deferred:** with N=3, you have three pairwise streams (A↔B, A↔C, B↔C) and patterns (2-vs-1 majority, all-three-different, all-three-agree). With N=4, six pairs — visually unworkable as side-by-side. The right paradigm is voting / clustering, which is a separate research and design problem.

**MVP behavior:** N≥3 falls back to N=2 layout with a pair-chooser. Adequate for experimenting with three or more agents but not a real ensemble UI.

**Trigger to un-defer:** when any pilot has been run with N≥3 enough times to make the chooser fallback painful, OR when methodology research argues that voting (e.g., 2-of-3 majority rule) produces materially better gap detection than pairwise (which would need its own investigation).

### Spec §14 deliverables beyond proposals + agent_errors

The spec calls for a "Guideline Calibration Package" with eight artifact types. MVP ships only two of them as automated outputs:
- Operational Guideline v1 — already exists (the locked guideline file).
- Adjudicated Case Set — already partially exists (review_state.json + new adjudications.json).
- Validated Evidence Library — **deferred.** Requires evidence-item-level taxonomy.
- Boundary Case and Example Bank — **deferred.** Partial today via `exemplars/`. Promoting it to a first-class deliverable requires a curation UI and a way to route adjudications classified as "good example" into the bank. Not load-bearing for the calibration loop.
- Guideline Gap and Resolution Log — partially covered by the existing `proposals/` flow; a richer log with status transitions is **deferred.**
- Agent Execution Error Backlog — shipping in MVP as `agent_errors.json` (flat list, no clustering).
- Retrieval / Keyword / Codeset Candidate List — **deferred** (Phase 3 concern per spec §16).
- Pilot Evaluation Report — **deferred** (the existing critique.json covers a thin version; a full evaluation report can be added later).

**Trigger to un-defer each:** when the calibration loop is producing outputs but the next bottleneck is *consuming* those outputs (e.g., reviewers want a curated boundary case bank to train new reviewers, or the team wants to start Phase 3 retrieval optimization and needs the candidate list).

### Skipped-note audit panel (spec §11.8)

**Why deferred:** the existing pipeline gives agents the full chart context, so "skipped notes" today means "notes the agent didn't cite as relevant evidence" — already visible in the chart timeline UI. The spec's audit panel adds structured human annotation of those skipped notes ("missed evidence type," "decision-changing? yes/no"). For MVP, the existing chart timeline + the disagreement queue cover the most important skipped-note cases (those where the agents disagree on relevance).

**Trigger to un-defer:** when MVP pilots reveal a class of guideline gaps that *only* appear in agreed-non-relevant notes, i.e., both agents skip the same thing and both miss the same evidence. That's exactly the §10.1 "agreed but wrong" failure mode that random-sample QA is supposed to catch.

### Chat-to-structured actions for evidence (spec §12.4)

**Why deferred:** chat exists today but writing structured annotations from chat is partial. For MVP, the structured form owns commits — chat is exploration only. This is consistent with the existing review-copilot skill's design.

**Trigger to un-defer:** when reviewers consistently use chat to draft adjudication content and have to re-type it into the form. That's the signal that the chat-to-structure bridge is worth building.

### Free-form custom role prompts beyond the registry

**Why deferred (more accurately: discouraged):** custom prompts are *allowed* in MVP via the `role_prompt` field, but flagged as "experimental — disagreement statistics not comparable to preset-based pilots." Cross-pilot aggregation (cohort-feedback, drift detection) requires consistent role configurations to be meaningful.

**Trigger to expand:** when the role-preset registry has matured to ~5–10 well-tested presets and there's evidence that one specific guideline domain needs a custom role pair that doesn't fit any preset.

---

## Implementation ordering recommendation

1. **M1 (run pipeline N-flexible)** — extend manifest schema, update `runs.ts` to loop, add `agent_specs[]` defaulting. Smallest unit; ships in days.
2. **Role preset registry + prompts** — create `prompts/agent_roles/` with `default.md` and `skeptical.md`. Trivial.
3. **M2 (disagreement extraction)** — pairwise comparison emitting `disagreements.json`. Borrow from existing kappa code path. Days.
4. **M3 (reviewer UI)** — the bulk of effort. Two-column side-by-side, disagreement queue, 4-option adjudication form. Probably 60% of total MVP effort.
5. **Output integration** — adapter from `adjudications.json` into the existing `improveGuideline` pipeline; emit `agent_errors.json`. Small.
6. **End-to-end pilot run on `patient_probable_fhx_01` + 2–4 more hard cases** (`patient_neg_hard_01`, plus 2–3 from the broader corpus chosen for guideline-stress potential). Validate that the live system reproduces the kind of signal the fake-dual test produced on paper.

The first real pilot iteration after MVP ships should explicitly target *generating ~5 guideline-gap proposals* rather than zero. iter_002's "1 patient, 0 proposals, insufficient_data" outcome is the failure baseline to beat.

---

## Resolved tactical decisions (Q9–Q12)

These were the four "open questions" from the prior section, driven to a decision in the same grilling session.

### Q9 — Disagreement queue layout: patient-first primary, summary tab secondary

The primary reviewer surface is **patient-first**: open a patient, see two drafts side-by-side, adjudicate that patient's disagreements, move on. This is an extension of the existing per-patient adjudication flow, not a new top-level navigation pattern.

A secondary **"disagreement summary by criterion"** tab provides the cross-cohort view spec §11.4 describes — a flat table grouped by criterion with `(patient, agent_1_answer, agent_2_answer, status)` columns and click-through into the patient-first adjudication view. Read-only roll-up; nothing richer (no clustering visualizations, no pattern detection UI) for MVP.

**Why patient-first as primary, not queue-first:**
- Chart context is expensive to load mentally. Adjudicating all of a patient's disagreements together amortizes that loading. Queue-first re-loads chart context per row.
- Reviewer time is the bottleneck during pilots; the patient-first workflow optimizes for it.
- Cross-criterion clustering is what `improveGuideline` does post-adjudication anyway. The reviewer doesn't need clusters while adjudicating; they need to adjudicate accurately.
- §10.1 random-sample agreement QA naturally fits a patient-first workflow ("open patient, glance at agreed criteria, sign off"). It does not fit queue-first.
- MVP scope: patient-first extends existing components; queue-first as primary requires a new top-level view.

**Concession to the spec:** if patient-first proves out and the team later wants queue-first as the primary workflow (high-volume pilots, reviewers specialized by criterion), that's a post-MVP UI refactor. The summary tab is the foothold.

### Q10 — Auto-collapse consensus criteria with random-sample expansion

When N=2 and both agents agree on a criterion, the criterion is **auto-collapsed** under a "X criteria agreed, Y disagreed" banner per patient. Two affordances:

1. **Per-patient "expand all" toggle.** Reviewer can drill into agreed criteria for any specific patient without changing the workflow.
2. **Random-sample expansion.** For every M-th patient in a pilot (default M=5), one randomly-chosen *agreed* criterion is force-expanded and the reviewer must validate it before completing that patient. This is the §10.1 cheap implementation: it catches agreed-but-wrong cases without forcing the reviewer to validate every agreement on every patient.

The random-sample seed and the expanded criterion are recorded in `adjudications.json` so the QA cannot be silently skipped.

### Q11 — Adjudication is optional, but unresolved items carry over

The reviewer can mark a pilot complete with unresolved disagreements. The completion gate surfaces "X disagreements unresolved" and requires an explicit confirmation reason. Unresolved items go to a `pilots/iter_NNN/unresolved.json` queue that the next iteration sees as carryover (so the system does not silently forget them).

This balances: the reviewer is not blocked when they hit truly hard cases (which is exactly when adjudication takes longest and may need expert input), but unresolved cases re-surface in the next iteration rather than disappearing into the audit log.

### Q12 — First dual-agent pilot patient set

The first dual-agent pilot runs on the **5 patients already set up in `reviews/` today**:

- `patient_easy_neg_01` — control / noise floor
- `patient_easy_nsclc_01` — control / noise floor
- `patient_easy_nsclc_02` — control / noise floor
- `patient_neg_hard_01` — hard case, expected to surface disagreement
- `patient_probable_fhx_01` — hard case, validated by the fake-dual test to surface a real guideline gap

Why these 5:
- **2 hard + 3 easy.** Hard cases are where signal is expected; easy cases are the control floor. If `[easy_neg_01, easy_nsclc_01, easy_nsclc_02]` produce disagreement at a similar rate to `[probable_fhx_01]`, the methodology has a noise problem on this guideline.
- **Already in `reviews/`** — no fixture-setup overhead; existing review_state.json scaffolds are in place.
- **Cost is negligible.** 5 patients × N=2 × ~$0.11 ≈ $1.10 per iteration.

If signal is real on this 5-patient run, the second iteration expands to ~10–15 patients drawing from `corpus/patients/` (e.g., `patient_confirmed_reread_01`, additional `patient_easy_icd_*`, more probable cases) for breadth. If signal is *not* real, the methodology hypothesis fails on this guideline and we revisit before scaling.

### Cost budget

iter_002 cost $0.11 for 1 patient; N=2 doubles that to ~$0.22/patient. A 10-patient dual-agent pilot is ~$2. Negligible at current scale. No budget gate for MVP, but flag for review if a pilot routinely exceeds 50+ patients.
