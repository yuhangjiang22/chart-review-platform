# Increment — Refine skills from human annotations (error analysis → better statement)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**User directive (2026-06-13):** "It should refine the skill based on **human
annotations**. Do some **error analysis** and find how to have a **better
statement in skills**."

This **supersedes** the attribution mechanism in the earlier self-refinement
plan (`2026-06-12-self-refinement.md`). That plan gated refinement on the
**judge's agent-vs-agent** `classification_hint`. The judge only fires when the
two drafting agents *disagree* (plus low-confidence / type-drift) — it has **zero
awareness of the human's validated answer**. So the single most valuable case to
refine — a **systematic gap where the model is wrong vs the human** (and, on a
strong model, *both* agents are wrong the same way, so they never disagree) — is
**invisible** to the old attribution. Confirmed empirically below.

## What the empirical error analysis found (2026-06-13)

Ran `cancer-diagnosis` (2 agents, `claude-sonnet`) on 7 easy + 7 harder
convention-stress patients (re-read addendum, history-of-cancer billing codes,
cytology-only, family-hx decoys, hard negative) and compared model output to a
careful human annotation of each chart.

**Finding 1 — the model + rubric are robust.** Near-zero model-vs-human
mismatches. The model correctly handled: the re-read addendum
(`patient_confirmed_reread_01` → `adenocarcinoma`, following the IHC + most-recent
read), Stage IIIA N2 staging (`has_distant_metastasis=no_info`: regional node ≠
distant), and billing-code-only charts (`no_info`). Both agents agreed on every
field, all high-confidence.

**Finding 2 — why "weaken a criterion" failed to produce errors.** I removed the
"regional lymph nodes are NOT distant" clause from `has_distant_metastasis` and
re-ran: the model *still* answered `no_info`. A strong model already knows the
TNM convention that M1 (distant) excludes N (regional). **Conventions that match
standard medical knowledge are redundant with the model's training** — removing
them doesn't cause errors.

**Finding 3 — the real latent gap (a *better statement* to add).** `cancer_type`
documents temporal *transformation* ("adeno that later transforms to small-cell →
most recent wins") but never states the **re-read / addendum convention**: when a
pathology *addendum or second-opinion re-read* (e.g. after IHC) reclassifies the
original morphologic diagnosis, the re-read is authoritative **regardless of
which appears first in the report or whether the addendum is dated**. The model
survived `patient_confirmed_reread_01` only because the chart spoon-fed it ("the
re-read is authoritative", addendum dated later, oncology note confirming). The
gap bites on the common real-world shape — a **same-day or undated addendum with
no oncology disambiguation** — where "most recent" cannot resolve it and the
report literally lists `DIAGNOSIS (ORIGINAL): SMALL-CELL CARCINOMA` *first* while
the rubric says "read the FINAL DIAGNOSIS line first."

**Proposed better statement (③) for `cancer_type` — "Conflicting / changing histology":**
> A pathology **addendum, re-read, or second-opinion revision** of the **same
> specimen** (e.g. a diagnosis revised after immunohistochemistry) is
> **authoritative and supersedes the original morphologic diagnosis, regardless
> of which appears first in the report or whether the addendum carries a later
> date**. (Distinguish this from biological *transformation* across *separate*
> specimens over time, where the most-recent specimen wins.)

**Implication for the loop:** the mismatches worth refining cluster on (a)
genuinely **ambiguous** cases and (b) **arbitrary project conventions that
deviate from clinical norms** (mixed histology like adenosquamous / LCNEC mapping;
registry-specific recurrence vs new-primary calls). The error-analysis pass must
distinguish a **rubric gap** (criterion underspecified → refine) from a **model
slip** (criterion clear → don't touch the rubric) — operating on the
model-vs-human pair directly, not on agent-vs-agent disagreement.

---

## The reoriented loop

```
validated iter (human annotations = reviewer-validated field_assessments)
   │
   ├─ model answer  (per_patient run-chain drafts, most-recent run)   [candidates.ts, exists]
   ├─ human answer  (source=reviewer leaf field_assessments)          [candidates.ts, exists]
   │
   ▼  for each (patient, field) where model ≠ human:
ERROR-ANALYSIS PASS (new — replaces agent-vs-agent judge gate)
   per mismatch: {criterion text, human-cited chart excerpt, model answer+rationale, human answer}
   → LLM returns { error_class: rubric_gap | genuine_ambiguity | model_slip,
                   what_rubric_misses, reasoning }
   → keep rubric_gap + genuine_ambiguity; drop model_slip (don't refine the rubric for a model error)
   │
   ▼ cluster rubric_gap mismatches by field
REFINER (exists: propose.ts) → ②③ better statement
HELD-OUT Δ (exists: holdout.ts) → ④
TRANSPARENT CARD ①②③④, human-applied (exists: RefineProposalCard)
```

The **only new piece** is the error-analysis pass; candidates/propose/holdout/card
already exist. It makes attribution come from the human annotation, so the loop
works even when the agents agreed (the systematic-gap case).

## Task EA1: Error-analysis attribution from human annotations
**Files:** new `server/lib/refine/error-analysis.ts`; wire into `candidates.ts`.
- [ ] `analyzeMismatch({taskId, fieldId, criterionDef, modelAnswer, modelRationale, humanAnswer, excerpt, noteId})` → one LLM call (reuse judge/propose plumbing: `runAgent` + `judgeModel()` + scratch-MCP + `<ERROR_ANALYSIS>` sentinel + strict schema) → `{ error_class: "rubric_gap"|"genuine_ambiguity"|"model_slip", what_rubric_misses, reasoning }`. Prompt: the human answer is GROUND TRUTH; decide whether the criterion as written would lead a careful reader to the model's (wrong) answer (→ rubric_gap / ambiguity) or whether the criterion is clear and the model simply erred (→ model_slip). Inline everything; read-only.
- [ ] Map `error_class` → the existing `classification_hint` vocabulary so `propose.ts`/`refine-routes` need no change: `rubric_gap→guideline_gap`, `genuine_ambiguity→true_ambiguity`, `model_slip→agent_error`.
- [ ] In `candidates.ts`: when a mismatch cell has **no** agent-vs-agent judge record (`unjudged`), fall back to the error-analysis attribution (model-vs-human). Cache results in the iter's `error_analyses.json` (mirror `judge_analyses.json`) so it's not re-run every read. Agent-vs-agent judge records, when present, still win (cheaper / already computed).
- [ ] typecheck → 0. Commit `feat(concur): refine — error-analysis attribution from human annotations`.

## Task EA2: Real fixture + demonstrate the card end-to-end
- [ ] Build a fixture that reliably yields a model-vs-human mismatch the model can't paper over with world knowledge — a **rubric-silence** case, not a redundant convention. Candidate: a `cancer_type` chart with **same-day / undated re-read addendum + no oncology disambiguation** (Finding 3), or a **mixed-histology** chart (adenosquamous / LCNEC) the enum doesn't map. Human annotation = the project's intended answer.
- [ ] Run → validate (human annotation) → `GET /candidates` (mismatch present, attributed via EA) → `POST /propose` → real card ①②③④ → surfaced on the PERFORMANCE Refine entry point.
- [ ] Commit the fixture + a screenshot/transcript of the populated card.

## Self-review
- Attribution from **human annotations** (model-vs-human), not agent-vs-agent — the user's directive; fixes the systematic-gap blind spot.
- `model_slip` is dropped (never refine the rubric for a model error) — the careful safeguard, preserved.
- Reuses propose/holdout/card; only the attribution source changes.
- Held-out Δ still gates every edit; human still applies the transparent card.
- One commit per task; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; no --no-verify.
