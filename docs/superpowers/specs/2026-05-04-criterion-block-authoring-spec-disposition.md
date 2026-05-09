# Criterion-block guideline authoring spec — disposition

**Date:** 2026-05-04
**Status:** Decided in /grill-me session; lifts queued for implementation
**Source spec:** the "Skill Spec: Criterion-Block Guideline Authoring" markdown pasted into the grilling session — a ~600-line proposal to author chart-review guidelines as `composite` blocks with explicit `decision_logic`, `revision_triggers`, and a parallel JSON output format.
**Predecessor specs:**
- `2026-05-02-chart-review-guideline-builder-design.md` — current `chart-review-build` skill design this proposal would have replaced
- `2026-05-03-skill-architecture-design.md` — atomicity-as-doctrine architecture context

This document records why the proposed spec was **not adopted**, the five narrow lifts that were extracted from it, the rationale, and the worked exemplars produced in the session. Future sessions encountering "should we revisit composite criterion authoring?" should read this before re-deriving the answer.

---

## Decision

**Reject the proposed spec as a whole. Lift five narrow pieces (A–E) into the existing platform.**

The proposed spec's central move was to abandon atomicity (`atomic-criteria.md` doctrine) in favor of "composite criterion blocks" — units that can bundle temporal, causal, or longitudinal judgment in one prose definition. That move is incompatible with three load-bearing pieces of the platform — criterion-level rerun + adjudication carry-forward, per-criterion κ, and adjudication granularity — and the worked exemplars in this session show it does not buy what it promises.

The lift list captures the parts of the spec that *were* genuinely new and useful:
- engine extensions to `derivation` (arithmetic + aggregation)
- a schema refinement to `examples` (split into structured arrays)
- two doctrine additions (applicability patterns; the outcome+reason axis split)
- a worked recipe in the build skill's interview guide

---

## The argument the session settled

### Atomic ≠ tiny

The proposed spec's framing — "atomicity forces tiny keyword-like criteria; real clinical judgment is composite" — is a strawman. `atomic-criteria.md` requires a single decision, single answer schema, single time scope, single resolved meaning, and independent revisability. **It does not require brevity.** A leaf criterion can carry paragraph-length clinical disambiguation prose and still be atomic.

This was the central confusion in the proposed spec, and it dissolves once named.

### κ separation is what's at stake

When two reviewers (or two agents) disagree on a criterion, the platform's value proposition is *knowing where they disagreed*. With atomic decomposition, per-criterion κ tells you whether the disagreement was on extraction, on threshold application, on applicability, or on reason. With composite blocks, all of these collapse into one κ on one number — useless for guideline-improvement signal.

This is not theoretical. The dual-agent MVP (`2026-05-02-agent-enhanced-chart-review-mvp.md`) is built around using disagreement signal to discover guideline gaps. Composite blocks would have *blunted* that signal at exactly the layer it needs to be sharp.

### Composite logic already has a home: `derivation`

The proposed spec's `composite` criterion type overlaps with the platform's existing `derivation` field. Where the spec wants one prose block bundling extraction + scoring, the platform already supports atomic leaves + a derivation expression that aggregates them. The two real expressivity gaps — arithmetic and aggregation — are bounded engine work, not a doctrine change.

---

## Three worked exemplars

The session walked three cases under both designs to test the argument empirically. Full YAML lives in conversation; the key takeaways are recorded here so the disposition does not depend on reconstructing them.

### Exemplar 1 — RUCAM DILI causality (scoring rubric)

7-domain causality score with thresholds, summed to a category. The spec used RUCAM as its design inspiration ("blocks are scoring units, not atomic decisions").

**Composite-block version:** one block per RUCAM domain, prose definition with scoring table, reviewer emits an integer.

**Atomic + derivation version:** per domain, 2–4 leaves (extracted dates, lab values, exclusion booleans) + 1 derived integer score per domain + 1 derived total + 1 derived category.

**Verdict:** atomic decomposition works cleanly. Each leaf carries paragraph-length clinical disambiguation (e.g., `liver_injury_onset_date` carries the "earliest of first ALT > 2× ULN or clinician-attributed symptom onset" rule); leaves are independently judgeable; per-domain κ separates extraction errors from threshold errors. Two engine gaps surfaced — arithmetic (date subtraction) and aggregation (`count_true` over alternative-cause exclusions) — both fixable in `~100 LoC`. Composite blocks would have collapsed extraction-vs-scoring κ, the diagnostic signal RUCAM-style scoring is *designed to produce*.

### Exemplar 2 — NCCN NSCLC pre-treatment workup concordance (checklist with applicability)

5-step checklist (pathology / imaging staging / brain imaging / molecular / PD-L1) with stage- and histology-dependent applicability gates. "Did each step happen before first systemic therapy?"

**Atomic version:** anchor leaf (`first_systemic_therapy_date`) + step evidence leaves + applicability gate criteria (e.g., `brain_imaging_required` = derived from `clinical_stage in ['II','III','IV']`) + per-step `step_met` derivations comparing dates + final `count_true` rollup.

**Verdict:** the platform's existing `is_applicable_when` and date `<=` comparison cover most of this. **No new engine features needed beyond `count_true`.** The pattern of "anchor leaf → step evidence leaves → applicability gates → step concordance derivations → count_true rollup" is the worked recipe lift D should encode in the build-skill interview guide.

### Exemplar 3 — GLP-1 recommendation and acceptance (small rubric, outcome+reason)

"Was GLP-1 recommended, and did the patient accept?" The simplest of the three; surfaced the **outcome+reason axis split** that became lift E.

**The trap:** "did the patient get GLP-1?" hides three categorically different axes — indication, recommendation (clinician behavior), acceptance (patient behavior). Bundling produces uninterpretable cohort numbers. Splitting yields a 7-category final output (`not_indicated / already_in_use / recommended_accepted / recommended_declined / recommended_deferred / indicated_not_recommended / no_info`) that distinguishes clinician inertia from patient autonomy from out-of-denominator cases — directly readable as a quality measure.

**Verdict:** confirms `atomic-criteria.md` §2 ("enum values share a single semantic axis") at small scale. Whenever a final-output enum tempts the author to sneak a reason value (`true_gap`, `refused`, `pending`) into the outcome axis, **split** — outcome leaf, reason leaf, gate the reason on `not_met`. This is lift E.

### What the three exemplars share

All three preserved atomicity. None required the spec's `composite` type. All three benefited from the same engine extensions (or a subset). The "outcome + reason" split appeared in two of them (NCCN's "non-concordant — why?" and GLP-1's "declined — why?") and is the most reusable authoring rule the session produced.

---

## The lift list

### Lift A — extend `derivation` with arithmetic + builtins

**What:** add `+ − * /` (binary, plus parser-level unary minus) and two builtins — `count_true([expr, ...])` and `days_between(d1, d2)` — to both implementations: `lib/chart_review/derivation.py` (Python reference) and `app/server/contract-eval.ts` (TS port).

**Why two builtins, not raw date subtraction:** the disposition originally proposed `date − date → integer days` as an operator. The TS port substitutes env values as JSON literals into a JS `Function()` body, and `string − string` evaluates to `NaN` in JS — different semantics from a Python error. A `days_between(d1, d2)` builtin is cross-language symmetric: both engines parse `YYYY-MM-DD` strings explicitly, return integer days, and propagate null on null/unparseable operands. Same rationale applied: `count_true(list)` is a builtin rather than a list-comprehension construct because builtins are easier to keep parity-clean than language-grammar additions.

**RUCAM/concordance idiom this enables:**
```
days_between(injury_onset_date, drug_start_date) >= 5 AND
days_between(injury_onset_date, drug_start_date) <= 90 ? 2 : 1
```
and
```
count_true([hav_excluded == 'yes', hbv_excluded == 'yes', ...]) >= 4
```

**Cross-language guarantees (parity-tested):**
- Null propagation through arithmetic: any null operand → null result.
- Division by zero (and any non-finite arithmetic result in JS — `Infinity`, `-Infinity`, `NaN`) → null.
- `count_true` skips null operands rather than counting them as falsy. Distinguishes "false" from "unknown."
- `days_between` requires `YYYY-MM-DD`; anything else returns null.
- Strict numeric operands for `+ − * /`: Python no longer silently does string repetition (`'foo' * 2` was a parity gap; now both engines return null for non-numeric arithmetic).

**Scope:** ~110 LoC across Python + TS, plus 30 corpus entries in `app/scripts/eval-parity-corpus.json`, plus a new `lib/tests/test_derivation_arithmetic.py` (24 tests) and 11 new TS test cases in `contract-eval.test.ts`. Backward-compatible — existing derivations parse and evaluate identically.

**Schema_hash impact:** none. Engine changes don't alter criterion content; existing carry-forward stays valid.

**Status:** **Shipped 2026-05-04.**

### Lift B — split `examples` into structured arrays

**What:** in the criterion YAML schema, replace `guidance_prose.examples` (one prose blob mixing positive + negative + boundary) with four structured fields:
- `satisfying_examples` — explicit positive cases
- `non_satisfying_examples` — explicit negative cases
- `boundary_examples` — ambiguous cases with the disambiguation rule
- `failure_modes` — common authoring/reviewer failure modes (the spec called this `common_failure_modes`)

**Why:** the spec's instinct here was correct — boundary cases and failure modes are first-class authoring information that today is buried in prose. Structured fields force the author to surface each axis, give reviewers a targeted reference during validation, and give `chart-review-improve` clean targets when proposing edits.

**Scope:** the four new fields nest under `guidance_prose` alongside `definition` and the legacy `examples`. They are strings (multiline, with bullet markers) — adjustment from the disposition's "structured arrays." Reasons: matches existing convention (`examples` is already a string), fits the JSON schema's `additionalProperties: { type: string }` without modification, parses cleanly through both the Python parser (handles arbitrary subsections) and the TS `loadPhenotypeCriteria` (extended for the new section names). Authors can still iterate with bullet syntax; downstream tooling that needs structured iteration can split on lines.

Implementation:
- `app/server/domain/rubric/yaml-to-markdown.ts` — emits four new section headings (Satisfying examples / Non-satisfying examples / Boundary examples / Failure modes); legacy `## Examples` still works.
- `app/server/domain/rubric/phenotype-skill.ts` — extended type + parser to read all four new sections back into `guidance_prose`. Also fixed a pre-existing regex bug where the section terminator `(?=\n##\s|\s*$)` with `m` flag stopped at the first end-of-line, truncating multi-line content. Hidden by lax test assertions; surfaced by lift-B round-trip tests with multi-line bodies.
- `chart-review-build/references/yaml-templates.md` and `chart-review-author/references/yaml-templates.md` — show the new shape as preferred.
- `chart-review-build/references/interview-guide.md` — Phase 5 satisfaction now requires ≥1 example across the four axes.
- `atomic-criteria.md` — adds an "Authoring convention — structured prose under `guidance_prose`" section.

**Schema_hash impact: none.** Resolves O1. The criterion-hash function explicitly excludes `guidance_prose`, `extraction_guidance`, `examples` from structural fields — so adding new prose keys does not invalidate carry-forward. The disposition's worry was based on an incorrect read of the hash function; it was already designed for this case.

**Status:** **Shipped 2026-05-04.** All four lifts complete + Lift A engine extensions.

### Lift C — applicability patterns section in `atomic-criteria.md`

**What:** add a new section showing the three patterns `is_applicable_when` cleanly handles:
1. Gate by another criterion's value (existing pathology→histology example)
2. Gate by stage / category (`brain_imaging_required` from NCCN exemplar)
3. Gate by treatment plan / context (`pdl1_required`, `glp1_clinically_indicated`)

Plus the key authoring rule: when a criterion is only meaningful in some cases, prefer `is_applicable_when` over folding the gate into prose.

**Why:** today `atomic-criteria.md` mentions `is_applicable_when` once in §G as one of seven checklist items; the worked exemplars showed it carrying real cross-criterion logic (applicability cascades through multiple gates). A patterns section makes the doctrine usable for authors writing real guidelines, not just for guideline-doctrine reviewers.

**Scope:** doc-only. ~80 lines added in `skills/chart-review/references/atomic-criteria.md` (between "Common violations" and "Atomicity at revision time"); the new section covers the three patterns plus the factor-vs-inline decision rule plus a §E-restated anti-pattern callout.

**Status:** **Shipped 2026-05-04.**

### Lift D — guideline-concordance worked exemplar in build-skill interview guide

**What:** add to `chart-review-build/references/interview-guide.md` a worked recipe for the "guideline concordance" output_shape, using the NCCN NSCLC exemplar as the worked case. Recipe shape:

> Anchor leaf for treatment date → step evidence leaves → applicability gates → per-step concordance derivations → `count_true` rollup → final concordance category.

**Why:** today the interview-guide is generic. Concordance is a common-enough output_shape (NCCN, AHA/ACC, ADA, CMS measures) that an author starting one without this recipe will almost certainly produce a non-atomic, prose-bundled rubric. The recipe makes the right design path obvious.

**Scope:** doc-only. ~140 lines in `chart-review-build/references/interview-guide.md` as a new "Worked recipe — guideline concordance rubrics" section (six layers: anchor → step evidence → applicability gates → per-step concordance → `count_true` rollups → final category), with NCCN NSCLC pre-treatment workup as the worked exemplar. Triggered by research-question keywords (concordance / adherence / NCCN / AHA / ADA / CMS / USPSTF). SKILL.md "Skill-specific references" updated to surface the recipe + push-back triggers.

**Status:** **Shipped 2026-05-04.**

### Lift E — outcome + reason axis split, doctrine + interview

**What:** add to `atomic-criteria.md` an explicit rule:

> Whenever an outcome enum tempts you to sneak a reason value (`true_gap`, `refused`, `pending`, `unknown`, `pending_outside_records`) into the outcome axis, **split**. The outcome is one criterion; the reason is a sibling criterion gated on `outcome == not_met` (or whichever value triggers reason elicitation). Reject any compound enum where two semantic axes share a slot.

Add to the build-skill interview a step that detects compound-axis enums and proposes the split conversationally.

**Why:** this rule appeared in both the NCCN concordance exemplar (step `not_met` reasons: refused / contraindicated / undocumented / true_gap) and the GLP-1 exemplar (decline reasons). It is the single most reusable authoring rule the session produced. It would have prevented the original spec's instinct to bundle outcome + reason in one composite block.

**Scope:** ~25 lines added to `atomic-criteria.md` as a new §G "Outcome + reason in one enum"; ~12 lines added to `chart-review-build/SKILL.md` as a parallel hard rule next to the existing compound-criterion rule; ~40 lines added to `chart-review-build/references/interview-guide.md` as a new "Push-back triggers" section with a worked dialogue (including the case where the reviewer insists on a compound enum).

**Status:** **Shipped 2026-05-04.**

---

## What was rejected and why

| Spec proposal | Rejection rationale |
|---|---|
| `composite` criterion type | Loses extraction-vs-scoring κ separation, breaks adjudication carry-forward. Already covered by atomic leaves + `derivation`. |
| Parallel JSON output format | Platform uses YAML on disk for guideline content. Adding a parallel JSON shape doubles maintenance with no analytical gain. |
| New "Criterion-Block Authoring" skill | Subsumed by existing `chart-review-build` + lifts A–E. A new skill would duplicate the interview infrastructure. |
| `decision_logic` as a separate JSON field | Already expressed by `derivation` on the final output criterion + `is_applicable_when` on gates. |
| `revision_triggers` schema | Already expressed by `chart-review-improve` proposals (`proposals/<id>/<proposal>.yaml`). |
| `quality_check` JSON output | Already expressed by `chart-review-calibrate` per-criterion κ + the `atomic-criteria.md` 7-item checklist applied at authoring time. |
| "Scope must come first" as a new requirement | Already enforced by `chart-review-build` phase 1 (`output_shape` is a hard gate before criteria). Renaming. |
| Stress-test cases as part of authoring | Already exists as `chart-review-calibrate`; the right place for case-based testing is *after* drafting, against ground-truth reviewers, not inside authoring. |

---

## Open questions (loose ends, deliberately deferred)

These are real questions surfaced in the session that do not need to be resolved before lifts A–E ship. Listed here so future-me does not re-derive them.

### O1 — `schema_hash` semantics for lift B (RESOLVED)

**Resolution:** non-issue by existing design. The criterion-hash function (`app/server/criterion-hash.ts`) explicitly excludes `guidance_prose`, `extraction_guidance`, and `examples` from structural fields (lines 5-8, 46-48). Adding the four new prose keys nested under `guidance_prose` is automatically a non-semantic change. Carry-forward is preserved.

### O2 — "appropriate deviation" denominator semantics

The NCCN concordance final enum includes `appropriate_deviation` (every unmet step has a justified reason). Different quality programs treat this differently:

- **Include in numerator** (concordant + appropriate_deviation = "meets standard")
- **Exclude from denominator** (out of measure)
- **Report separately** (parallel rate)

This is a study-design choice, not a platform-design choice. The schema supports all three (the leaves are the same; the cohort-table aggregation varies). Defer to whichever study first uses guideline-concordance.

### O3 — reusable reason-axis enum

The 5-value reason enum (`refused_by_patient / clinically_contraindicated / undocumented / true_gap / no_info`) recurs across guideline-concordance studies. Should it be a reusable enum referenced by ID (like a code set), or copied per-study?

Recommend: copy per-study for the first 2–3 guidelines, then extract a shared enum if the values stabilize. Premature extraction would force studies to either accept values that don't fit or fork the shared enum.

### O4 — multi-drug RUCAM iteration

RUCAM is run per-drug. The current platform (one chart-review record = one rubric run) handles this by creating two records for two-drug assessment. If a real DILI study needs in-rubric iteration over a drug list, that's a platform-feature gap, not a schema gap. Defer until forced.

---

## Implementation order

1. **Lift A** (engine extensions) — **shipped 2026-05-04.**
2. **Lift C** (applicability patterns doc) — **shipped 2026-05-04.**
3. **Lift E** (outcome+reason doctrine + interview step) — **shipped 2026-05-04.**
4. **Lift D** (concordance interview recipe) — **shipped 2026-05-04.**
5. **Lift B** (structured examples) — **shipped 2026-05-04.** All five lifts complete.

---

## Trigger conditions to revisit

Reopen this disposition if any of:

1. **Authoring blocked by atomicity.** A real study tries to author a leaf that genuinely cannot be split into single decisions, where the prose-driven judgment unit is irreducibly composite. None of the three exemplars produced one; if a fourth case does, document it concretely (not as a worry) and we re-grill.
2. **Engine extensions insufficient.** Lift A ships but a real rubric needs an operator we did not add (e.g., regex match in derivations, list comprehension, recursive aggregation). Probably extend the engine again rather than abandon the design.
3. **Per-criterion κ proves uninformative.** If, across multiple pilots, the per-leaf κ separation never produces actionable signal — i.e., extraction κ and scoring κ track each other identically — then the cost of atomic decomposition stops paying. Unlikely on the evidence so far, but documentable.

---

## References

- The proposed spec: pasted into the 2026-05-04 grilling session (full text in conversation history). Quote that captures its central move: *"Do not force all criteria to be tiny atomic units… A criterion can be temporal, causal, or longitudinal if it is a stable judgment unit."*
- `skills/chart-review/references/atomic-criteria.md` — the atomicity doctrine the proposed spec would have abandoned
- `lib/chart_review/derivation.py` — 313-line expression evaluator that lift A extends
- `2026-05-02-agent-enhanced-chart-review-mvp.md` — the dual-agent MVP whose disagreement-signal value depends on per-criterion κ separation
- `2026-05-02-chart-review-guideline-builder-design.md` — `chart-review-build` design that lifts D and E patch into

The three worked exemplars (RUCAM DILI, NCCN NSCLC concordance, GLP-1 recommendation+acceptance) live in the grilling-session conversation history. If a future session needs them rebuilt as standalone reference rubrics, the GLP-1 case is the smallest (6 criteria) and the cleanest demonstration of the outcome+reason split.
